use super::{
    RoleSessionMigrationPhase, RoleSessionMigrationPlatform, RoleSessionMigrationRecord,
    RoleSessionMigrationTransitionInput, domain_error, invalid_transition_error,
};
use crate::error::CoreResult;

pub(super) const FIRST_CHROMIUM_TARGET_REVISION: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransitionAuthority {
    SourceRuntime {
        expected_platform: RoleSessionMigrationPlatform,
    },
    TargetRuntime {
        expected_platform: RoleSessionMigrationPlatform,
    },
    ImportAdmission {
        expected_platform: RoleSessionMigrationPlatform,
    },
}

impl TransitionAuthority {
    fn expected_platform(self) -> RoleSessionMigrationPlatform {
        match self {
            Self::SourceRuntime { expected_platform }
            | Self::TargetRuntime { expected_platform }
            | Self::ImportAdmission { expected_platform } => expected_platform,
        }
    }
}

pub(super) struct AuthoritativeMigrationFields {
    pub target_revision: Option<u64>,
    pub envelope_sha256: Option<String>,
    pub inventory_sha256: Option<String>,
    pub cookie_count: Option<u64>,
    pub local_storage_origin_count: Option<u64>,
    pub local_storage_entry_count: Option<u64>,
    pub clean_flush_receipt_id: Option<String>,
    pub reset_receipt_id: Option<String>,
}

impl AuthoritativeMigrationFields {
    fn from_record(record: &RoleSessionMigrationRecord) -> Self {
        Self {
            target_revision: record.target_revision,
            envelope_sha256: record.envelope_sha256.clone(),
            inventory_sha256: record.inventory_sha256.clone(),
            cookie_count: record.cookie_count,
            local_storage_origin_count: record.local_storage_origin_count,
            local_storage_entry_count: record.local_storage_entry_count,
            clean_flush_receipt_id: record.clean_flush_receipt_id.clone(),
            reset_receipt_id: record.reset_receipt_id.clone(),
        }
    }

    fn from_input(input: &RoleSessionMigrationTransitionInput) -> Self {
        Self {
            target_revision: input.target_revision,
            envelope_sha256: input.envelope_sha256.clone(),
            inventory_sha256: input.inventory_sha256.clone(),
            cookie_count: input.cookie_count,
            local_storage_origin_count: input.local_storage_origin_count,
            local_storage_entry_count: input.local_storage_entry_count,
            clean_flush_receipt_id: input.clean_flush_receipt_id.clone(),
            reset_receipt_id: input.reset_receipt_id.clone(),
        }
    }

    fn matches_input(&self, input: &RoleSessionMigrationTransitionInput) -> bool {
        self.target_revision == input.target_revision
            && self.envelope_sha256 == input.envelope_sha256
            && self.inventory_sha256 == input.inventory_sha256
            && self.cookie_count == input.cookie_count
            && self.local_storage_origin_count == input.local_storage_origin_count
            && self.local_storage_entry_count == input.local_storage_entry_count
            && self.clean_flush_receipt_id == input.clean_flush_receipt_id
            && self.reset_receipt_id == input.reset_receipt_id
    }
}

pub(super) fn authoritative_transition_fields(
    current: &RoleSessionMigrationRecord,
    input: &RoleSessionMigrationTransitionInput,
    authority: TransitionAuthority,
) -> CoreResult<AuthoritativeMigrationFields> {
    use RoleSessionMigrationPhase::{
        Exported, Importing, Indeterminate, V22Ready, V23Ready, Verifying,
    };

    let fields = match (current.phase, input.next_phase, authority) {
        (Exported, Importing, TransitionAuthority::ImportAdmission { .. }) => {
            let mut fields = AuthoritativeMigrationFields::from_record(current);
            fields.target_revision = Some(FIRST_CHROMIUM_TARGET_REVISION);
            fields
        }
        (V22Ready, Exported, TransitionAuthority::SourceRuntime { .. }) => {
            AuthoritativeMigrationFields::from_input(input)
        }
        (Importing | Indeterminate, Verifying, TransitionAuthority::TargetRuntime { .. }) => {
            let mut fields = AuthoritativeMigrationFields::from_record(current);
            if fields.clean_flush_receipt_id.is_none() {
                fields.clean_flush_receipt_id = input.clean_flush_receipt_id.clone();
            }
            fields
        }
        _ => AuthoritativeMigrationFields::from_record(current),
    };

    if !fields.matches_input(input)
        || (current.phase == V23Ready
            && input.next_phase == V23Ready
            && (input.stable_error_code != current.stable_error_code
                || input.outcome != current.outcome))
    {
        return Err(invalid_transition_error());
    }
    Ok(fields)
}

pub(super) fn validate_transition_platform(
    platform: RoleSessionMigrationPlatform,
    authority: TransitionAuthority,
) -> CoreResult<()> {
    if platform != authority.expected_platform() {
        return Err(domain_error(
            "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
            "The role session migration journal does not match the active shell platform.",
        ));
    }
    Ok(())
}

pub(super) fn authorize_transition(
    current: RoleSessionMigrationPhase,
    next: RoleSessionMigrationPhase,
    authority: TransitionAuthority,
) -> CoreResult<()> {
    use RoleSessionMigrationPhase::{
        Exported, Failed, Importing, Indeterminate, V22Ready, V23Ready, Verifying,
    };

    let authorized = match authority {
        TransitionAuthority::SourceRuntime { .. } => matches!(
            (current, next),
            (V22Ready, Exported | Failed | Indeterminate)
        ),
        TransitionAuthority::TargetRuntime { .. } => matches!(
            (current, next),
            (Importing, Verifying | Failed | Indeterminate)
                | (Verifying, V23Ready | Failed | Indeterminate)
                | (Indeterminate, Verifying)
                | (V23Ready, V23Ready)
        ),
        TransitionAuthority::ImportAdmission { .. } => (current, next) == (Exported, Importing),
    };
    if !authorized {
        return Err(invalid_transition_error());
    }
    Ok(())
}

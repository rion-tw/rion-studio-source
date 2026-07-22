use chrono::Utc;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        LegalAcceptDocumentsInputRecord, LegalAcceptanceRecord, LegalAcceptanceStatusRecord,
        LegalDocumentVersionsRecord,
    },
};

pub(crate) fn status(
    acceptance: Option<&LegalAcceptanceRecord>,
    versions: LegalDocumentVersionsRecord,
) -> LegalAcceptanceStatusRecord {
    let is_accepted = acceptance.is_some_and(|acceptance| {
        acceptance.accepted_terms_version == versions.terms
            && acceptance.accepted_fair_use_version == versions.fair_use
            && acceptance.acknowledged_privacy_version == versions.privacy
    });
    LegalAcceptanceStatusRecord {
        current_versions: versions,
        is_accepted,
        accepted_at: acceptance.map(|value| value.accepted_at.clone()),
        accepted_fair_use_version: acceptance.map(|value| value.accepted_fair_use_version.clone()),
        accepted_terms_version: acceptance.map(|value| value.accepted_terms_version.clone()),
        acknowledged_privacy_version: acceptance
            .map(|value| value.acknowledged_privacy_version.clone()),
    }
}

pub(crate) fn accept(
    versions: &LegalDocumentVersionsRecord,
    input: LegalAcceptDocumentsInputRecord,
) -> CoreResult<LegalAcceptanceRecord> {
    if input.terms_version != versions.terms
        || input.fair_use_version != versions.fair_use
        || input.privacy_version != versions.privacy
    {
        return Err(CoreError::Domain {
            code: "LEGAL_VERSIONS_OUTDATED",
            message: "Legal document versions are out of date.".to_owned(),
        });
    }
    Ok(LegalAcceptanceRecord {
        accepted_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        accepted_fair_use_version: input.fair_use_version,
        accepted_terms_version: input.terms_version,
        acknowledged_privacy_version: input.privacy_version,
        schema_version: 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versions() -> LegalDocumentVersionsRecord {
        LegalDocumentVersionsRecord {
            fair_use: "f1".to_owned(),
            privacy: "p1".to_owned(),
            terms: "t1".to_owned(),
        }
    }

    #[test]
    fn validates_versions_and_owns_acceptance_timestamp() {
        let acceptance = accept(
            &versions(),
            LegalAcceptDocumentsInputRecord {
                fair_use_version: "f1".to_owned(),
                privacy_version: "p1".to_owned(),
                terms_version: "t1".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(acceptance.schema_version, 1);
        assert!(chrono::DateTime::parse_from_rfc3339(&acceptance.accepted_at).is_ok());
        assert!(status(Some(&acceptance), versions()).is_accepted);
    }

    #[test]
    fn rejects_stale_document_versions() {
        let error = accept(
            &versions(),
            LegalAcceptDocumentsInputRecord {
                fair_use_version: "old".to_owned(),
                privacy_version: "p1".to_owned(),
                terms_version: "t1".to_owned(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "LEGAL_VERSIONS_OUTDATED");
    }
}

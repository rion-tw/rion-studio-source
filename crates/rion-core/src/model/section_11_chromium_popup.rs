#[derive(Debug, Clone, Copy, Deserialize, Eq, Hash, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromiumPopupOwnerKind {
    Role,
    GlobalWeb,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromiumPopupDisposition {
    NewWindow,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromiumPopupOpenerPolicy {
    IsolatedNoopener,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromiumPopupLifecyclePhase {
    Admitted,
    NativeReady,
    Ready,
    Closing,
    Closed,
    Cancelled,
    Failed,
    Indeterminate,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromiumPopupParentFenceRecord {
    pub owner_kind: ChromiumPopupOwnerKind,
    pub owner_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slot_id: Option<String>,
    #[ts(type = "number")]
    pub owner_native_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub role_owner_generation: Option<u64>,
    pub parent_window_id: String,
    #[ts(type = "number")]
    pub parent_window_generation: u64,
    #[ts(type = "number")]
    pub parent_topology_revision: u64,
    pub parent_tab_id: String,
    pub parent_attempt_generation: String,
    #[ts(type = "number")]
    pub parent_native_host_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_appkit_identity: Option<AppKitRuntimeHostIdentityRecord>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromiumPopupOpenRequestRecord {
    pub request_id: String,
    pub parent: ChromiumPopupParentFenceRecord,
    pub parent_target: EmbeddedLaunchTargetRecord,
    pub target_url: String,
    pub disposition: ChromiumPopupDisposition,
    pub opener_policy: ChromiumPopupOpenerPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub referrer_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub referrer_policy: Option<String>,
    pub raw_features: String,
    pub has_post_body: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromiumPopupAdmissionRecord {
    pub request_id: String,
    pub popup_id: String,
    pub open_operation_id: String,
    #[ts(type = "number")]
    pub lifecycle_revision: u64,
    pub parent: ChromiumPopupParentFenceRecord,
    pub target: EmbeddedLaunchTargetRecord,
    pub title: String,
    #[ts(type = "\"about:blank\"")]
    pub creation_url: String,
    pub target_url: String,
    pub disposition: ChromiumPopupDisposition,
    pub opener_policy: ChromiumPopupOpenerPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub referrer_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub referrer_policy: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromiumPopupNativeHostReceiptRecord {
    #[ts(type = "\"macos\" | \"windows\"")]
    pub platform: String,
    #[ts(type = "number")]
    pub native_host_id: u64,
    pub logical_window_id: String,
    #[ts(type = "number")]
    pub window_generation: u64,
    #[ts(type = "number")]
    pub topology_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub appkit_identity: Option<AppKitRuntimeHostIdentityRecord>,
}

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromiumPopupCloseReason {
    User,
    ParentRetired,
    ApplicationShutdown,
    NavigationRejected,
    LoadFailed,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum ChromiumPopupLifecycleActionRecord {
    NativeReady {
        host: ChromiumPopupNativeHostReceiptRecord,
    },
    PageReady {
        final_url: String,
    },
    CloseRequested {
        reason: ChromiumPopupCloseReason,
    },
    NativeClosed,
    Cancelled {
        failure_code: String,
    },
    Failed {
        failure_code: String,
        native_state_unknown: bool,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromiumPopupLifecycleEventRecord {
    pub event_id: String,
    pub popup_id: String,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub parent: ChromiumPopupParentFenceRecord,
    pub action: ChromiumPopupLifecycleActionRecord,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct ChromiumPopupLifecycleReceiptRecord {
    pub event_id: String,
    pub popup_id: String,
    pub operation_id: String,
    #[ts(type = "number")]
    pub lifecycle_revision: u64,
    pub phase: ChromiumPopupLifecyclePhase,
    pub status: SystemRuntimeOperationStatus,
    pub completion_scope: SystemRuntimeOperationCompletionScope,
    pub operation_terminal: bool,
    pub lifecycle_terminal: bool,
    pub close_native: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure_code: Option<String>,
}

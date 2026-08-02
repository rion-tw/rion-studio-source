impl SystemRuntimeExecutor {
    fn capability_evidence(&self) -> Vec<EngineCapabilityEvidenceRecord> {
        let platform = if cfg!(target_os = "macos") {
            rion_platform::Platform::Macos
        } else {
            rion_platform::Platform::Windows
        };
        let probe = rion_platform::probe_system_webview(platform);
        let runtime_available = probe.available;
        let audio_mute_available = runtime_available && probe.audio_mute_available;
        let macro_input_available = runtime_available && probe.macro_input_available;
        let entries = [
            (
                "navigation",
                supported_if(runtime_available),
                "runtimeProbe",
                "allow",
            ),
            (
                "persistentSession",
                supported_if(runtime_available),
                "roleStoreProbe",
                "isolated-role-store",
            ),
            (
                "trustedInput",
                supported_if(macro_input_available),
                "nativeInputProbe",
                "fenced-native-dispatch",
            ),
            (
                "backgroundInput",
                supported_if(macro_input_available),
                "nativeInputProbe",
                "fenced-native-dispatch",
            ),
            (
                "frameEvaluation",
                degraded_if(runtime_available),
                "runtimeProbe",
                "top-frame-bounded",
            ),
            (
                "popup",
                degraded_if(runtime_available),
                "policyInstall",
                "scoped-owner",
            ),
            (
                "audioMute",
                supported_if(audio_mute_available),
                "runtimeProbe",
                "per-view",
            ),
            (
                "customFonts",
                degraded_if(runtime_available),
                "documentStart",
                "origin-scoped",
            ),
            (
                "downloads",
                EngineCapabilityStatus::Disabled,
                "policyInstall",
                "deny",
            ),
            (
                "fileUpload",
                supported_if(runtime_available),
                "runtimeProbe",
                "allow",
            ),
            (
                "permissions",
                degraded_if(runtime_available),
                "policyInstall",
                "deny-by-default",
            ),
            (
                "dialogs",
                supported_if(runtime_available),
                "policyInstall",
                "native-guarded",
            ),
            (
                "certificateHandling",
                supported_if(runtime_available),
                "policyInstall",
                "reject-invalid",
            ),
        ];
        entries
            .into_iter()
            .map(|(capability, status, evidence_stage, policy_mode)| {
                EngineCapabilityEvidenceRecord {
                    capability: capability.to_owned(),
                    status,
                    contract_version: SYSTEM_RUNTIME_CONTRACT_VERSION,
                    probe_result: match status {
                        EngineCapabilityStatus::Supported => "verified",
                        EngineCapabilityStatus::Degraded => "partial",
                        EngineCapabilityStatus::Unsupported => "unsupported",
                        EngineCapabilityStatus::Disabled => "unavailable",
                    }
                    .to_owned(),
                    policy_mode: policy_mode.to_owned(),
                    evidence_stage: evidence_stage.to_owned(),
                    failure_reason: match status {
                        EngineCapabilityStatus::Supported => None,
                        EngineCapabilityStatus::Degraded => {
                            Some("partial-platform-guarantee".to_owned())
                        }
                        EngineCapabilityStatus::Unsupported => {
                            Some("platform-runtime-unsupported".to_owned())
                        }
                        EngineCapabilityStatus::Disabled => {
                            Some("runtime-or-policy-unavailable".to_owned())
                        }
                    },
                }
            })
            .collect()
    }
}

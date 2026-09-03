impl AppCore {
    async fn clear_global_web_profile(self: &Arc<Self>) -> CoreResult<Value> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION {
            return Err(CoreError::Domain {
                code: "GLOBAL_WEB_PROFILE_RUNTIME_UNAVAILABLE",
                message:
                    "The global Web Chromium profile is unavailable before runtime contract v23."
                        .to_owned(),
            });
        }
        let core = Arc::clone(self);
        let profile = tokio::task::spawn_blocking(move || {
            crate::global_web_profile::ensure(&core.user_data_dir)
        })
        .await
        .map_err(|error| CoreError::Internal(error.to_string()))??;
        let effect = self
            .request_core_effect(
                "global-web",
                CoreEffectAction::GlobalWebProfileClear {
                    profile: profile.clone(),
                },
                Duration::from_secs(30),
            )
            .await?;
        crate::global_web_profile::validate(&profile)?;
        serde_json::to_value(crate::model::GlobalWebProfileClearReceiptRecord {
            operation_id: effect.operation_id,
            profile,
            status: crate::model::SystemRuntimeOperationStatus::Applied,
        })
        .map_err(|error| CoreError::Internal(error.to_string()))
    }
}

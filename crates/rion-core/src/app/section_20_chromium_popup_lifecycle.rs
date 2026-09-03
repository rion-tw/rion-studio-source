impl AppCore {
    fn admit_chromium_popup(
        &self,
        request: crate::model::ChromiumPopupOpenRequestRecord,
    ) -> CoreResult<crate::model::ChromiumPopupAdmissionRecord> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION {
            return Err(CoreError::Domain {
                code: "CHROMIUM_POPUP_RUNTIME_UNAVAILABLE",
                message: "Controlled Chromium popups require runtime contract v23.".to_owned(),
            });
        }
        let registration = self.browser_runtime_registration()?;
        if !registration.available
            || registration.engine != crate::model::ResolvedBrowserEngine::Chromium
            || registration.capabilities.popup
                != crate::model::EngineCapabilityStatus::Supported
        {
            return Err(CoreError::Domain {
                code: "CHROMIUM_POPUP_CAPABILITY_UNAVAILABLE",
                message: "The registered Chromium runtime has not proven popup capability."
                    .to_owned(),
            });
        }
        self.validate_chromium_popup_parent(&request)?;
        self.popup_lifecycle
            .lock()
            .map_err(|_| CoreError::Internal("popup lifecycle lock poisoned".to_owned()))?
            .admit(request)
    }

    fn commit_chromium_popup_lifecycle(
        &self,
        event: crate::model::ChromiumPopupLifecycleEventRecord,
    ) -> CoreResult<crate::model::ChromiumPopupLifecycleReceiptRecord> {
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION {
            return Err(CoreError::Domain {
                code: "CHROMIUM_POPUP_RUNTIME_UNAVAILABLE",
                message: "Controlled Chromium popups require runtime contract v23.".to_owned(),
            });
        }
        self.popup_lifecycle
            .lock()
            .map_err(|_| CoreError::Internal("popup lifecycle lock poisoned".to_owned()))?
            .apply_event(event, self.platform)
    }

    fn validate_chromium_popup_parent(
        &self,
        request: &crate::model::ChromiumPopupOpenRequestRecord,
    ) -> CoreResult<()> {
        let parent = &request.parent;
        let snapshot = self.browser_runtime.snapshot()?;
        let window = snapshot
            .windows
            .get(&parent.parent_window_id)
            .ok_or_else(|| popup_parent_superseded("parent runtime window no longer exists"))?;
        if window.window_generation != parent.parent_window_generation
            || window.revision != parent.parent_topology_revision
            || !window.contains_tab(&parent.parent_tab_id)
        {
            return Err(popup_parent_superseded(
                "parent window, generation, topology revision, or tab changed",
            ));
        }
        validate_popup_parent_target(window, &request.parent_target)?;
        let tab = snapshot
            .browser_runtime
            .tabs
            .iter()
            .find(|tab| tab.id == parent.parent_tab_id)
            .ok_or_else(|| popup_parent_superseded("parent browser tab no longer exists"))?;
        if tab.window_id != parent.parent_window_id
            || tab.attempt_generation.as_deref()
                != Some(parent.parent_attempt_generation.as_str())
        {
            return Err(popup_parent_superseded(
                "parent browser-tab attempt generation changed",
            ));
        }
        match parent.owner_kind {
            crate::model::ChromiumPopupOwnerKind::Role => {
                if parent.slot_id.is_some() || parent.role_owner_generation.is_none() {
                    return Err(popup_parent_invalid(
                        "a role popup fence has invalid role ownership fields",
                    ));
                }
                let role = snapshot
                    .browser_runtime
                    .roles
                    .iter()
                    .find(|role| role.role_id == parent.owner_id)
                    .ok_or_else(|| popup_parent_superseded("managed role owner retired"))?;
                if role.owner.tab_id != parent.parent_tab_id
                    || Some(role.owner.generation) != parent.role_owner_generation
                {
                    return Err(popup_parent_superseded(
                        "managed role owner generation changed",
                    ));
                }
            }
            crate::model::ChromiumPopupOwnerKind::GlobalWeb => {
                if parent.role_owner_generation.is_some() {
                    return Err(popup_parent_invalid(
                        "a global Web popup cannot claim a role owner generation",
                    ));
                }
                let slot_id = parent.slot_id.as_deref().ok_or_else(|| {
                    popup_parent_invalid("a global Web popup requires an exact slot identity")
                })?;
                if !tab.web_surfaces.iter().any(|surface| {
                    surface.surface_id == parent.owner_id && surface.slot_id == slot_id
                }) {
                    return Err(popup_parent_superseded(
                        "global Web surface or slot owner changed",
                    ));
                }
            }
        }
        match self.platform {
            rion_platform::Platform::Macos => {
                let identity = parent.parent_appkit_identity.as_ref().ok_or_else(|| {
                    popup_parent_invalid("macOS popup admission requires an AppKit parent identity")
                })?;
                if identity.logical_window_id != parent.parent_window_id
                    || identity.launch_generation.trim().is_empty()
                    || identity.native_generation < 1
                {
                    return Err(popup_parent_superseded(
                        "the AppKit parent host identity changed",
                    ));
                }
            }
            rion_platform::Platform::Windows if parent.parent_appkit_identity.is_some() => {
                return Err(popup_parent_invalid(
                    "a Windows popup cannot claim an AppKit parent identity",
                ));
            }
            rion_platform::Platform::Windows => {}
        }
        Ok(())
    }
}

fn validate_popup_parent_target(
    window: &crate::runtime_kernel::RuntimeLiveWindowRecord,
    target: &crate::model::EmbeddedLaunchTargetRecord,
) -> CoreResult<()> {
    let placement = window
        .placement
        .as_ref()
        .ok_or_else(|| popup_parent_superseded("parent window has no committed placement"))?;
    let display = window
        .target_display
        .as_ref()
        .ok_or_else(|| popup_parent_superseded("parent window has no committed display"))?;
    if target.window_id != window.window_id {
        return Err(popup_parent_target_mismatch(
            "windowId",
            &window.window_id,
            &target.window_id,
        ));
    }
    if target.persisted_name != window.persisted_name {
        return Err(popup_parent_target_mismatch(
            "persistedName",
            &window.persisted_name,
            &target.persisted_name,
        ));
    }
    if target.display_id != display.id {
        return Err(popup_parent_target_mismatch(
            "displayId",
            &display.id,
            &target.display_id,
        ));
    }
    if let Some(fingerprint) = display.fingerprint.as_ref()
        && target.scale_factor != fingerprint.scale_factor
    {
        return Err(popup_parent_target_mismatch(
            "scaleFactor",
            &fingerprint.scale_factor,
            &target.scale_factor,
        ));
    }
    if target.work_area != placement.saved_work_area {
        return Err(popup_parent_target_mismatch(
            "workArea",
            &placement.saved_work_area,
            &target.work_area,
        ));
    }
    if target.bounds != placement.normal_bounds {
        return Err(popup_parent_target_mismatch(
            "bounds",
            &placement.normal_bounds,
            &target.bounds,
        ));
    }
    if target.presentation != placement.presentation {
        return Err(popup_parent_target_mismatch(
            "presentation",
            &placement.presentation,
            &target.presentation,
        ));
    }
    Ok(())
}

fn popup_parent_target_mismatch<Expected, Received>(
    field: &str,
    expected: &Expected,
    received: &Received,
) -> CoreError
where
    Expected: std::fmt::Debug + ?Sized,
    Received: std::fmt::Debug + ?Sized,
{
    popup_parent_superseded(&format!(
        "parent native target field `{field}` no longer matches the Core placement; Core expected {expected:?}, request supplied {received:?}",
    ))
}

fn popup_parent_invalid(message: &str) -> CoreError {
    CoreError::Domain {
        code: "CHROMIUM_POPUP_PARENT_FENCE_INVALID",
        message: message.to_owned(),
    }
}

fn popup_parent_superseded(message: &str) -> CoreError {
    CoreError::Domain {
        code: "CHROMIUM_POPUP_PARENT_SUPERSEDED",
        message: message.to_owned(),
    }
}

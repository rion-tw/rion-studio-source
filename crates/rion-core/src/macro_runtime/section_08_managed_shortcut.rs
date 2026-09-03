pub(crate) struct ManagedShortcutPhaseDispatch<'a> {
    pub operation_id: &'a str,
    pub role_id: &'a str,
    pub surface_generation: u64,
    pub document_instance_id: &'a str,
    pub press_id: &'a str,
    pub code: &'a str,
    pub phase: &'a str,
    pub modifier_codes: &'a [String],
}

impl MacroRuntime {
    pub fn dispatch_managed_shortcut_phase(
        &self,
        dispatch: ManagedShortcutPhaseDispatch<'_>,
    ) -> CoreResult<Vec<String>> {
        let phase = match dispatch.phase {
            "replay" => "tap",
            "keyDown" => "hold",
            "keyUp" => "release",
            _ => {
                return Err(CoreError::Domain {
                    code: "MANAGED_SHORTCUT_PHASE_INVALID",
                    message: "The managed shortcut phase is invalid.".to_owned(),
                });
            }
        };
        let mut modifiers = dispatch
            .modifier_codes
            .iter()
            .filter_map(|code| {
                if code.starts_with("Alt") {
                    Some("alt")
                } else if code.starts_with("Control") {
                    Some("ctrl")
                } else if code.starts_with("Meta") {
                    Some("meta")
                } else if code.starts_with("Shift") {
                    Some("shift")
                } else {
                    None
                }
            })
            .map(str::to_owned)
            .collect::<Vec<_>>();
        modifiers.sort();
        modifiers.dedup();
        let control = new_invocation_control(
            format!("managed-shortcut:{}", dispatch.operation_id),
            format!("managed-shortcut:{}", dispatch.press_id),
            HashSet::from([dispatch.role_id.to_owned()]),
        );
        let exact_surface = ExactBrowserActionSurface {
            role_id: dispatch.role_id.to_owned(),
            surface_generation: dispatch.surface_generation,
            document_instance_id: dispatch.document_instance_id.to_owned(),
        };
        perform_actions_with_control(
            &self.shared,
            &control,
            vec![(
                dispatch.role_id,
                BrowserAction::Key {
                    phase: phase.to_owned(),
                    key: dispatch.code.to_owned(),
                    code: Some(dispatch.code.to_owned()),
                    modifiers,
                    owner_id: format!("managed-shortcut:{}", dispatch.press_id),
                    suppress_overlay_shortcut: true,
                },
            )],
            false,
            Some(&exact_surface),
        )
        .map_err(|failure| CoreError::Effect {
            code: failure.cause_code,
            message: failure.message,
        })
    }

    pub fn retire_managed_shortcut_surface(
        &self,
        role_id: &str,
        surface_generation: u64,
        document_instance_id: &str,
        shortcuts: &[(String, String, Vec<String>)],
    ) -> CoreResult<Vec<String>> {
        if shortcuts.is_empty() {
            return Ok(Vec::new());
        }
        let control = new_invocation_control(
            format!("managed-shortcut-retire:{role_id}:{surface_generation}"),
            format!("managed-shortcut-retire:{document_instance_id}"),
            HashSet::from([role_id.to_owned()]),
        );
        let exact_surface = ExactBrowserActionSurface {
            role_id: role_id.to_owned(),
            surface_generation,
            document_instance_id: document_instance_id.to_owned(),
        };
        let actions = shortcuts
            .iter()
            .map(|(press_id, code, modifier_codes)| {
                let mut modifiers = modifier_codes
                    .iter()
                    .filter_map(|modifier| {
                        if modifier.starts_with("Alt") {
                            Some("alt")
                        } else if modifier.starts_with("Control") {
                            Some("ctrl")
                        } else if modifier.starts_with("Meta") {
                            Some("meta")
                        } else if modifier.starts_with("Shift") {
                            Some("shift")
                        } else {
                            None
                        }
                    })
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                modifiers.sort();
                modifiers.dedup();
                (
                    role_id,
                    BrowserAction::Key {
                        phase: "release".to_owned(),
                        key: code.clone(),
                        code: Some(code.clone()),
                        modifiers,
                        owner_id: format!("managed-shortcut:{press_id}"),
                        suppress_overlay_shortcut: true,
                    },
                )
            })
            .collect::<Vec<_>>();
        perform_actions_with_control(
            &self.shared,
            &control,
            actions,
            true,
            Some(&exact_surface),
        )
        .map_err(|failure| CoreError::Effect {
            code: failure.cause_code,
            message: failure.message,
        })
    }
}

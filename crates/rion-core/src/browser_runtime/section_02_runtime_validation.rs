fn validate_role_slot_inputs(
    tab_type: &str,
    slots: &[crate::model::RuntimeRoleSlotInputRecord],
) -> CoreResult<()> {
    if tab_type == "role" && slots.is_empty() {
        return Err(domain(
            "RUNTIME_ROLE_SLOTS_REQUIRED",
            "A runtime role tab must contain at least one role slot.",
        ));
    }
    let mut slot_ids = HashSet::new();
    let mut role_ids = HashSet::new();
    for slot in slots {
        if slot.slot_id.trim().is_empty()
            || slot.role_id.trim().is_empty()
            || !slot_ids.insert(slot.slot_id.as_str())
            || !role_ids.insert(slot.role_id.as_str())
            || slot.browser_zoom_percent.is_some_and(|percent| {
                !percent.is_finite() || !(25.0..=500.0).contains(&percent)
            })
        {
            return Err(domain(
                "RUNTIME_ROLE_SLOT_INVALID",
                "A runtime role slot is invalid or duplicated.",
            ));
        }
    }
    Ok(())
}

fn validate_web_surface_identities(
    tab_type: &str,
    tab_id: &str,
    surfaces: &[crate::model::EmbeddedWebSurfaceIdentityRecord],
) -> CoreResult<()> {
    if !surfaces.is_empty() && tab_type != "workspace" {
        return Err(domain(
            "RUNTIME_WEB_SURFACE_TAB_INVALID",
            "Only a workspace tab may own Web surface identities.",
        ));
    }
    let mut surface_ids = HashSet::new();
    let mut slot_ids = HashSet::new();
    for surface in surfaces {
        if surface.surface_id.trim().is_empty()
            || surface.slot_id.trim().is_empty()
            || !surface.surface_id.starts_with(&format!("web-{tab_id}-"))
            || !surface_ids.insert(surface.surface_id.as_str())
            || !slot_ids.insert(surface.slot_id.as_str())
        {
            return Err(domain(
                "RUNTIME_WEB_SURFACE_IDENTITY_INVALID",
                "A runtime Web surface identity is invalid or duplicated.",
            ));
        }
    }
    Ok(())
}

fn workspace_state(slots: &[RuntimeRoleSlotRecord]) -> &'static str {
    if slots.iter().any(|slot| slot.state == "stopping") {
        "stopping"
    } else if slots.iter().all(|slot| slot.state == "running") {
        "running"
    } else if slots.iter().any(|slot| slot.state == "launching")
        && slots
            .iter()
            .all(|slot| matches!(slot.state.as_str(), "launching" | "running"))
    {
        "launching"
    } else {
        "partial"
    }
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

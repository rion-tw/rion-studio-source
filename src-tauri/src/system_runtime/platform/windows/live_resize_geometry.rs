#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::system_runtime) struct WindowsLiveResizeBounds {
    pub(in crate::system_runtime) height: i32,
    pub(in crate::system_runtime) width: i32,
    pub(in crate::system_runtime) x: i32,
    pub(in crate::system_runtime) y: i32,
}

pub(in crate::system_runtime) fn windows_live_resize_resolve_bounds(
    plan: &WindowsLiveResizePlan,
    physical_width: u32,
    physical_height: u32,
    scale: f64,
) -> Result<Vec<WindowsLiveResizeBounds>, ()> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(());
    }
    let logical_width = (f64::from(physical_width) / scale).round().max(1.0) as i32;
    let logical_height = (f64::from(physical_height) / scale).round().max(1.0) as i32;
    let tab_height = plan.tab_strip_height.round().clamp(1.0, f64::from(logical_height)) as i32;
    let role_inputs = plan
        .roles
        .iter()
        .map(|role| role.input.clone())
        .collect::<Vec<_>>();
    let descriptors = rion_core::create_workspace_dividers(&role_inputs);
    let output = rion_core::resolve_workspace_layout(&WorkspaceLayoutInput {
        active: true,
        hidden: false,
        window_visible: true,
        content_bounds: LayoutBounds {
            x: 0,
            y: tab_height,
            width: logical_width,
            height: (logical_height - tab_height).max(1),
        },
        gap: plan.gap,
        roles: role_inputs,
        dividers: descriptors
            .iter()
            .map(|divider| LayoutDividerInput {
                axis: divider.axis.clone(),
                before_role_ids: divider.before_role_ids.clone(),
                after_role_ids: divider.after_role_ids.clone(),
            })
            .collect(),
    });
    let mut bounds = Vec::with_capacity(1 + output.roles.len() + output.dividers.len());
    bounds.push(WindowsLiveResizeBounds {
        height: windows_live_resize_edge(tab_height, scale, physical_height as i32),
        width: physical_width.max(1) as i32,
        x: 0,
        y: 0,
    });
    for role in &plan.roles {
        let resolved = output
            .roles
            .iter()
            .find(|candidate| candidate.role_id == role.input.role_id)
            .ok_or(())?;
        bounds.push(windows_live_resize_physical_bounds(
            resolved.bounds.clone(),
            logical_width,
            logical_height,
            physical_width as i32,
            physical_height as i32,
            scale,
        ));
    }
    for divider in &plan.dividers {
        let resolved = output
            .dividers
            .iter()
            .find(|candidate| candidate.index == divider.index)
            .ok_or(())?;
        bounds.push(windows_live_resize_physical_bounds(
            windows_live_resize_divider_hit_bounds(&divider.axis, resolved.bounds.clone()),
            logical_width,
            logical_height,
            physical_width as i32,
            physical_height as i32,
            scale,
        ));
    }
    Ok(bounds)
}

pub(in crate::system_runtime) fn windows_live_resize_edge(value: i32, scale: f64, outer: i32) -> i32 {
    if value <= 0 {
        0
    } else {
        ((f64::from(value) * scale).round() as i32).min(outer)
    }
}

pub(in crate::system_runtime) fn windows_live_resize_physical_bounds(
    bounds: LayoutBounds,
    logical_width: i32,
    logical_height: i32,
    physical_width: i32,
    physical_height: i32,
    scale: f64,
) -> WindowsLiveResizeBounds {
    let left = windows_live_resize_edge(bounds.x, scale, physical_width);
    let top = windows_live_resize_edge(bounds.y, scale, physical_height);
    let right = if bounds.x + bounds.width >= logical_width {
        physical_width
    } else {
        windows_live_resize_edge(bounds.x + bounds.width, scale, physical_width)
    };
    let bottom = if bounds.y + bounds.height >= logical_height {
        physical_height
    } else {
        windows_live_resize_edge(bounds.y + bounds.height, scale, physical_height)
    };
    WindowsLiveResizeBounds {
        height: (bottom - top).max(1),
        width: (right - left).max(1),
        x: left,
        y: top,
    }
}

pub(in crate::system_runtime) fn windows_live_resize_divider_hit_bounds(axis: &str, bounds: LayoutBounds) -> LayoutBounds {
    let hit = DIVIDER_HIT_TARGET.round() as i32;
    if axis == "vertical" {
        LayoutBounds {
            x: bounds.x - (hit - bounds.width) / 2,
            width: hit,
            ..bounds
        }
    } else {
        LayoutBounds {
            y: bounds.y - (hit - bounds.height) / 2,
            height: hit,
            ..bounds
        }
    }
}

pub(in crate::system_runtime) fn windows_live_resize_submit_batch(
    surfaces: &[WindowsLiveResizeSurface],
    bounds: &[WindowsLiveResizeBounds],
) -> Result<(), ()> {
    // WebView2 controllers live under Wry child-host HWNDs. The outer Game
    // Window can resize without Wry resizing those hosts, so first fill every
    // distinct host with the participating client extent, then place each
    // controller relative to it. A host can be shared by multiple controllers,
    // and moving it once per surface gives it contradictory rects.
    windows_live_resize_submit_ordered(
        surfaces,
        bounds,
        |surface| windows_hwnd_key(surface.hwnd),
        |surface, host_bounds| unsafe {
            SetWindowPos(
                surface.hwnd,
                None,
                host_bounds.x,
                host_bounds.y,
                host_bounds.width,
                host_bounds.height,
                windows_live_resize_window_pos_flags(),
            )
            .map_err(|_| ())
        },
        |surface, bounds| {
            windows_live_resize_submit_controller_bounds(surface, bounds, |surface, bounds| unsafe {
                surface
                    .controller
                    .SetBounds(windows_live_resize_controller_rect(bounds))
            }
            .map_err(|_| ()))
        },
    )
}

pub(in crate::system_runtime) fn windows_live_resize_controller_rect(
    bounds: &WindowsLiveResizeBounds,
) -> RECT {
    RECT {
        bottom: bounds.y.saturating_add(bounds.height),
        left: bounds.x,
        right: bounds.x.saturating_add(bounds.width),
        top: bounds.y,
    }
}

pub(in crate::system_runtime) fn windows_live_resize_host_bounds(
    bounds: &[WindowsLiveResizeBounds],
) -> Option<WindowsLiveResizeBounds> {
    let right = bounds
        .iter()
        .map(|bounds| bounds.x.saturating_add(bounds.width))
        .max()?;
    let bottom = bounds
        .iter()
        .map(|bounds| bounds.y.saturating_add(bounds.height))
        .max()?;
    (right > 0 && bottom > 0).then_some(WindowsLiveResizeBounds {
        height: bottom,
        width: right,
        x: 0,
        y: 0,
    })
}

pub(in crate::system_runtime) fn windows_live_resize_window_pos_flags(
) -> windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS {
    SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_NOOWNERZORDER | SWP_NOZORDER
}

pub(in crate::system_runtime) fn windows_live_resize_submit_controller_bounds<T>(
    surface: &T,
    bounds: &WindowsLiveResizeBounds,
    set_bounds: impl FnOnce(&T, &WindowsLiveResizeBounds) -> Result<(), ()>,
) -> Result<(), ()> {
    set_bounds(surface, bounds)
}

pub(in crate::system_runtime) fn windows_live_resize_submit_ordered<T>(
    surfaces: &[T],
    bounds: &[WindowsLiveResizeBounds],
    parent_key: impl Fn(&T) -> usize,
    mut submit_parent_bounds: impl FnMut(&T, &WindowsLiveResizeBounds) -> Result<(), ()>,
    mut submit_controller_bounds: impl FnMut(&T, &WindowsLiveResizeBounds) -> Result<(), ()>,
) -> Result<(), ()> {
    if surfaces.len() != bounds.len() || surfaces.is_empty() {
        return Err(());
    }
    let host_bounds = windows_live_resize_host_bounds(bounds).ok_or(())?;
    let mut submitted_parents = Vec::new();
    let mut failed = false;
    for surface in surfaces {
        let key = parent_key(surface);
        if submitted_parents.contains(&key) {
            continue;
        }
        submitted_parents.push(key);
        if submit_parent_bounds(surface, &host_bounds).is_err() {
            failed = true;
        }
    }
    for (surface, bounds) in surfaces.iter().zip(bounds) {
        if submit_controller_bounds(surface, bounds).is_err() {
            failed = true;
        }
    }
    if failed {
        Err(())
    } else {
        Ok(())
    }
}

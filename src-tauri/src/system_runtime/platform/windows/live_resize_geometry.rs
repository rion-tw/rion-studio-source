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
    let drag_handle_width = if plan.window_draggable {
        windows_live_resize_edge(
            WINDOWS_NATIVE_DRAG_HANDLE_WIDTH_LOGICAL.round() as i32,
            scale,
            physical_width.saturating_sub(1) as i32,
        )
    } else {
        0
    };
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
        width: (physical_width as i32 - drag_handle_width).max(1),
        x: drag_handle_width,
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
    windows_live_resize_submit_ordered(
        surfaces,
        bounds,
        |surfaces, bounds| {
            let mut deferred =
                unsafe { BeginDeferWindowPos(surfaces.len() as i32) }.map_err(|_| ())?;
            let flags = windows_live_resize_window_pos_flags();
            for (surface, bounds) in surfaces.iter().zip(bounds) {
                deferred = unsafe {
                    DeferWindowPos(
                        deferred,
                        surface.hwnd,
                        None,
                        bounds.x,
                        bounds.y,
                        bounds.width,
                        bounds.height,
                        flags,
                    )
                }
                .map_err(|_| ())?;
            }
            unsafe { EndDeferWindowPos(deferred) }.map_err(|_| ())
        },
        |surface, bounds| {
            windows_live_resize_submit_controller_bounds(
                surface,
                bounds,
                |surface, bounds| unsafe {
                    surface.controller.SetBounds(RECT {
                        left: 0,
                        top: 0,
                        right: bounds.width,
                        bottom: bounds.height,
                    })
                }
                .map_err(|_| ()),
            )
        },
    )
}

pub(in crate::system_runtime) fn windows_live_resize_submit_controller_bounds<T>(
    surface: &T,
    bounds: &WindowsLiveResizeBounds,
    set_bounds: impl FnOnce(&T, &WindowsLiveResizeBounds) -> Result<(), ()>,
) -> Result<(), ()> {
    set_bounds(surface, bounds)
}

pub(in crate::system_runtime) fn windows_live_resize_window_pos_flags() -> windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS {
    SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_NOOWNERZORDER | SWP_NOZORDER
}

pub(in crate::system_runtime) fn windows_live_resize_submit_ordered<T>(
    surfaces: &[T],
    bounds: &[WindowsLiveResizeBounds],
    submit_child_batch: impl FnOnce(&[T], &[WindowsLiveResizeBounds]) -> Result<(), ()>,
    mut submit_controller_bounds: impl FnMut(&T, &WindowsLiveResizeBounds) -> Result<(), ()>,
) -> Result<(), ()> {
    if surfaces.len() != bounds.len() || surfaces.is_empty() {
        return Err(());
    }
    submit_child_batch(surfaces, bounds)?;
    for (surface, bounds) in surfaces.iter().zip(bounds) {
        submit_controller_bounds(surface, bounds)?;
    }
    Ok(())
}

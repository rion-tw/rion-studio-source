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
    let mut chrome_bounds = Vec::new();
    for role in &plan.roles {
        let resolved = output
            .roles
            .iter()
            .find(|candidate| candidate.role_id == role.input.role_id)
            .ok_or(())?;
        let slot = resolved.bounds.clone();
        let chrome_height = WORKSPACE_WEB_CHROME_HEIGHT
            .round()
            .min(f64::from((slot.height - 1).max(0))) as i32;
        let content = if role.chrome_label.is_some() && !role.fullscreen {
            LayoutBounds {
                y: slot.y + chrome_height,
                height: (slot.height - chrome_height).max(1),
                ..slot.clone()
            }
        } else {
            slot.clone()
        };
        bounds.push(windows_live_resize_physical_bounds(
            content,
            logical_width,
            logical_height,
            physical_width as i32,
            physical_height as i32,
            scale,
        ));
        if role.chrome_label.is_some() {
            let chrome = LayoutBounds {
                height: chrome_height.max(1),
                ..slot
            };
            chrome_bounds.push(windows_live_resize_physical_bounds(
                chrome,
                logical_width,
                logical_height,
                physical_width as i32,
                physical_height as i32,
                scale,
            ));
        }
    }
    bounds.extend(chrome_bounds);
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
    root: HWND,
    surfaces: &[WindowsLiveResizeSurface],
    bounds: &[WindowsLiveResizeBounds],
) -> Result<(), ()> {
    if !windows_live_resize_batch_surfaces_match_root(surfaces, |surface| {
        windows_live_resize_surface_belongs_to_root(surface, root)
    }) {
        return Err(());
    }
    // WebView2 controllers live under Wry child-host HWNDs. Wry normally gives
    // every child WebView its own host, but keep shared hosts supported by
    // grouping surfaces by their actual parent HWND. Each host occupies only
    // its group's union and each controller is positioned in host-local space.
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
    )?;
    windows_live_resize_verify_batch(root, surfaces, bounds)
}

pub(in crate::system_runtime) fn windows_live_resize_batch_surfaces_match_root<T>(
    surfaces: &[T],
    mut belongs_to_root: impl FnMut(&T) -> bool,
) -> bool {
    !surfaces.is_empty() && surfaces.iter().all(&mut belongs_to_root)
}

pub(in crate::system_runtime) fn windows_live_resize_verify_batch(
    root: HWND,
    surfaces: &[WindowsLiveResizeSurface],
    bounds: &[WindowsLiveResizeBounds],
) -> Result<(), ()> {
    windows_live_resize_verify_ordered(
        surfaces,
        bounds,
        |surface| windows_hwnd_key(surface.hwnd),
        |surface| {
            let mut host_client = RECT::default();
            let mut host_origin = POINT::default();
            unsafe {
                GetClientRect(surface.hwnd, &mut host_client).map_err(|_| ())?;
                ClientToScreen(surface.hwnd, &mut host_origin)
                    .ok()
                    .map_err(|_| ())?;
                ScreenToClient(root, &mut host_origin)
                    .ok()
                    .map_err(|_| ())?;
            }
            windows_live_resize_bounds_from_rect(host_client, host_origin.x, host_origin.y)
        },
        |surface| {
            let mut controller = RECT::default();
            unsafe { surface.controller.Bounds(&mut controller) }.map_err(|_| ())?;
            windows_live_resize_bounds_from_rect(controller, controller.left, controller.top)
        },
    )
}

pub(in crate::system_runtime) fn windows_live_resize_bounds_from_rect(
    rect: RECT,
    x: i32,
    y: i32,
) -> Result<WindowsLiveResizeBounds, ()> {
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    (width > 0 && height > 0)
        .then_some(WindowsLiveResizeBounds {
            height,
            width,
            x,
            y,
        })
        .ok_or(())
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

pub(in crate::system_runtime) fn windows_live_resize_union_bounds(
    bounds: &[WindowsLiveResizeBounds],
) -> Option<WindowsLiveResizeBounds> {
    let left = bounds.iter().map(|bounds| bounds.x).min()?;
    let top = bounds.iter().map(|bounds| bounds.y).min()?;
    let right = bounds
        .iter()
        .map(|bounds| bounds.x.saturating_add(bounds.width))
        .max()?;
    let bottom = bounds
        .iter()
        .map(|bounds| bounds.y.saturating_add(bounds.height))
        .max()?;
    (right > left && bottom > top).then_some(WindowsLiveResizeBounds {
        height: bottom.saturating_sub(top),
        width: right.saturating_sub(left),
        x: left,
        y: top,
    })
}

pub(in crate::system_runtime) fn windows_live_resize_local_bounds(
    bounds: &WindowsLiveResizeBounds,
    host_bounds: &WindowsLiveResizeBounds,
) -> WindowsLiveResizeBounds {
    WindowsLiveResizeBounds {
        height: bounds.height,
        width: bounds.width,
        x: bounds.x.saturating_sub(host_bounds.x),
        y: bounds.y.saturating_sub(host_bounds.y),
    }
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
    let parent_groups = windows_live_resize_parent_groups(surfaces, bounds, &parent_key)?;

    let mut failed = false;
    for (_, representative_index, host_bounds) in &parent_groups {
        let surface = &surfaces[*representative_index];
        if submit_parent_bounds(surface, host_bounds).is_err() {
            failed = true;
        }
    }
    for (surface, bounds) in surfaces.iter().zip(bounds) {
        let key = parent_key(surface);
        let host_bounds = parent_groups
            .iter()
            .find_map(|(candidate, _, bounds)| (*candidate == key).then_some(bounds))
            .ok_or(())?;
        let local_bounds = windows_live_resize_local_bounds(bounds, host_bounds);
        if submit_controller_bounds(surface, &local_bounds).is_err() {
            failed = true;
        }
    }
    if failed {
        Err(())
    } else {
        Ok(())
    }
}

pub(in crate::system_runtime) fn windows_live_resize_verify_ordered<T>(
    surfaces: &[T],
    bounds: &[WindowsLiveResizeBounds],
    parent_key: impl Fn(&T) -> usize,
    mut read_parent_bounds: impl FnMut(&T) -> Result<WindowsLiveResizeBounds, ()>,
    mut read_controller_bounds: impl FnMut(&T) -> Result<WindowsLiveResizeBounds, ()>,
) -> Result<(), ()> {
    let parent_groups = windows_live_resize_parent_groups(surfaces, bounds, &parent_key)?;
    for (_, representative_index, expected) in &parent_groups {
        let actual = read_parent_bounds(&surfaces[*representative_index])?;
        if actual != *expected {
            return Err(());
        }
    }
    for (surface, expected) in surfaces.iter().zip(bounds) {
        let key = parent_key(surface);
        let host_bounds = parent_groups
            .iter()
            .find_map(|(candidate, _, bounds)| (*candidate == key).then_some(bounds))
            .ok_or(())?;
        let expected = windows_live_resize_local_bounds(expected, host_bounds);
        if read_controller_bounds(surface)? != expected {
            return Err(());
        }
    }
    Ok(())
}

pub(in crate::system_runtime) fn windows_live_resize_parent_groups<T>(
    surfaces: &[T],
    bounds: &[WindowsLiveResizeBounds],
    parent_key: impl Fn(&T) -> usize,
) -> Result<Vec<(usize, usize, WindowsLiveResizeBounds)>, ()> {
    if surfaces.len() != bounds.len() || surfaces.is_empty() {
        return Err(());
    }
    let mut parent_groups = Vec::new();
    for (index, (surface, surface_bounds)) in surfaces.iter().zip(bounds).enumerate() {
        let key = parent_key(surface);
        if let Some((_, _, host_bounds)) = parent_groups
            .iter_mut()
            .find(|(candidate, _, _)| *candidate == key)
        {
            *host_bounds = windows_live_resize_union_bounds(&[*host_bounds, *surface_bounds])
                .ok_or(())?;
        } else {
            parent_groups.push((key, index, *surface_bounds));
        }
    }
    Ok(parent_groups)
}

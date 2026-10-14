use napi_derive::napi;

#[napi(object)]
pub struct AppKitDesktopE2ETitlebarGeometry {
    pub root_min_x: f64,
    pub root_width: f64,
    pub tab_min_x: f64,
    pub tab_min_y: f64,
    pub tab_max_x: f64,
    pub tab_max_y: f64,
    pub window_name_max_x: f64,
    pub traffic_lights_max_x: f64,
    pub fullscreen_control_min_x: f64,
    pub fullscreen_control_min_y: f64,
    pub fullscreen_control_width: f64,
    pub fullscreen_control_height: f64,
    pub title_hidden: bool,
    pub valid: bool,
}

#[napi(object)]
pub struct AppKitDesktopE2ETabAnchor {
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
pub struct AppKitDesktopE2EMinimumFrameSize {
    pub width: f64,
    pub height: f64,
}

#[napi(object)]
pub struct AppKitDesktopE2EFullscreenToolbarState {
    pub accessory_visible_height: f64,
    pub minimum_frame_size: AppKitDesktopE2EMinimumFrameSize,
    pub menu_bar_reveal: f64,
    pub toolbar_reveal: f64,
    pub reveal_sequence: u32,
    pub on_active_space: bool,
    pub add_button_on_screen: bool,
    pub always_hide_tab_close_button: bool,
    pub always_show_in_full_screen: bool,
    pub accessory_on_screen: bool,
    pub fullscreen: bool,
    pub fullscreen_host_ready: bool,
    pub presentation_auto_hide_toolbar: bool,
    pub reveal_locked: bool,
    pub tab_strip_on_screen: bool,
    pub toolbar_pinned: bool,
    pub tab_close_button_enabled_count: u32,
    pub visible_traffic_light_count: u32,
    pub window_name_on_screen: bool,
    pub valid: bool,
}

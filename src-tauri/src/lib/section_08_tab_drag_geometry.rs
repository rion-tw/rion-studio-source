fn tab_drag_order_changed(original: &[String], current: &[String]) -> bool {
    original != current
}

fn logical_tab_drag_screen_point(
    screen_x: f64,
    screen_y: f64,
    scale_factor: f64,
    physical_coordinates: bool,
) -> (f64, f64) {
    if physical_coordinates {
        let scale = scale_factor.max(f64::EPSILON);
        (screen_x / scale, screen_y / scale)
    } else {
        (screen_x, screen_y)
    }
}

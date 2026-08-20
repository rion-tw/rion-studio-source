#[test]
fn workspace_web_normal_bounds_reserve_sibling_chrome_without_covering_content() {
    let slot = RoleBounds {
        x: 12.0,
        y: 20.0,
        width: 800.0,
        height: 450.0,
    };
    let (chrome, content) = workspace_web_surface_bounds(slot, false);
    assert_eq!(chrome.x, slot.x);
    assert_eq!(chrome.y, slot.y);
    assert_eq!(chrome.width, slot.width);
    assert_eq!(chrome.height, WORKSPACE_WEB_CHROME_HEIGHT);
    assert_eq!(content.y, slot.y + WORKSPACE_WEB_CHROME_HEIGHT);
    assert_eq!(content.height, slot.height - WORKSPACE_WEB_CHROME_HEIGHT);
    assert_eq!(content.y + content.height, slot.y + slot.height);
}

#[test]
fn workspace_web_fullscreen_expands_only_content_to_the_slot_envelope() {
    let slot = RoleBounds {
        x: 1.0,
        y: 2.0,
        width: 640.0,
        height: 360.0,
    };
    let (chrome, content) = workspace_web_surface_bounds(slot, true);
    assert_eq!(chrome.height, 0.0);
    assert_eq!(content.x, slot.x);
    assert_eq!(content.y, slot.y);
    assert_eq!(content.width, slot.width);
    assert_eq!(content.height, slot.height);
}

#[test]
fn workspace_web_tiny_slots_retain_one_pixel_of_site_content() {
    let slot = RoleBounds {
        x: 0.0,
        y: 0.0,
        width: 3.0,
        height: 12.0,
    };
    let (chrome, content) = workspace_web_surface_bounds(slot, false);
    assert_eq!(chrome.height, 11.0);
    assert_eq!(content.height, 1.0);
}

#[test]
fn workspace_web_chrome_urls_are_http_only_and_default_to_https() {
    assert_eq!(
        checked_workspace_chrome_url("youtube.com/watch?v=test")
            .unwrap()
            .as_str(),
        "https://youtube.com/watch?v=test"
    );
    assert!(checked_workspace_chrome_url("https://netflix.com/").is_ok());
    assert!(checked_workspace_chrome_url("javascript:alert(1)").is_err());
    assert!(checked_workspace_chrome_url("youtube cats").is_err());
}

#[test]
fn workspace_chrome_is_a_shared_process_surface_released_after_page_surfaces() {
    assert_eq!(
        ManagedSurfaceKind::WorkspaceChrome.release_boundary(),
        SurfaceReleaseBoundary::SharedBrowserProcess
    );
    assert!(
        managed_surface_close_priority(ManagedSurfaceKind::Role)
            < managed_surface_close_priority(ManagedSurfaceKind::WorkspaceChrome)
    );
}

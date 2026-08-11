fn observed_placement(
    presentation: ObservedWindowPresentation,
    sequence: u64,
) -> ObservedWindowPlacement {
    ObservedWindowPlacement {
        display_id: 8,
        normal_bounds: Some(StatePixelBoundsRecord {
            x: 110,
            y: 120,
            width: 1000,
            height: 700,
        }),
        presentation,
        scale_factor: 2.0,
        sequence,
        window_generation: 4,
        window_id: "window-a".to_owned(),
        work_area: StatePixelBoundsRecord {
            x: 80,
            y: 40,
            width: 1720,
            height: 1060,
        },
    }
}

fn current_placement_target() -> EmbeddedLaunchTargetRecord {
    EmbeddedLaunchTargetRecord {
        window_id: "window-a".to_owned(),
        display_id: 7,
        scale_factor: 1.0,
        work_area: StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
        },
        bounds: StatePixelBoundsRecord {
            x: 10,
            y: 20,
            width: 900,
            height: 600,
        },
        presentation: "normal".to_owned(),
    }
}

#[test]
fn normal_window_placement_replaces_the_complete_restore_bounds() {
    let current = current_placement_target();
    let observed = observed_placement(ObservedWindowPresentation::Normal, 12);

    let reduction = reduce_observed_window_placement(&current, 4, 11, &observed)
        .expect("the latest generation-matched placement should be accepted");
    let target = reduction.target.expect("normal placement should commit");

    assert_eq!(target.bounds, observed.normal_bounds.unwrap());
    assert_eq!(target.display_id, 8);
    assert_eq!(target.work_area, observed.work_area);
    assert_eq!(target.scale_factor, 2.0);
    assert_eq!(target.presentation, "normal");
}

#[test]
fn maximized_and_fullscreen_observations_preserve_normal_restore_bounds() {
    let current = current_placement_target();
    for presentation in [
        ObservedWindowPresentation::Maximized,
        ObservedWindowPresentation::Fullscreen,
    ] {
        let mut observed = observed_placement(presentation, 12);
        observed.normal_bounds = Some(StatePixelBoundsRecord {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
        });

        let target = reduce_observed_window_placement(&current, 4, 11, &observed)
            .and_then(|reduction| reduction.target)
            .expect("non-normal placement should update the mode");

        assert_eq!(target.bounds, current.bounds);
        assert_eq!(target.display_id, 8);
        assert_eq!(
            target.presentation,
            presentation.persisted().expect("persisted presentation")
        );
    }
}

#[test]
fn restoring_to_normal_replaces_the_previous_saved_normal_bounds() {
    let mut current = current_placement_target();
    current.presentation = "maximized".to_owned();
    let observed = observed_placement(ObservedWindowPresentation::Normal, 13);

    let target = reduce_observed_window_placement(&current, 4, 12, &observed)
        .and_then(|reduction| reduction.target)
        .expect("the authoritative restored frame should commit");

    assert_eq!(target.presentation, "normal");
    assert_eq!(target.bounds, observed.normal_bounds.unwrap());
}

#[test]
fn minimized_observations_advance_the_fence_without_changing_saved_placement() {
    let current = current_placement_target();
    let observed = observed_placement(ObservedWindowPresentation::Minimized, 12);

    let reduction = reduce_observed_window_placement(&current, 4, 11, &observed)
        .expect("minimized is an authoritative event");

    assert_eq!(reduction.sequence, 12);
    assert!(reduction.target.is_none());
}

#[test]
fn stale_duplicate_and_wrong_generation_observations_are_rejected() {
    let current = current_placement_target();
    let observed = observed_placement(ObservedWindowPresentation::Normal, 12);

    assert!(reduce_observed_window_placement(&current, 4, 12, &observed).is_none());
    assert!(reduce_observed_window_placement(&current, 5, 11, &observed).is_none());

    let mut wrong_window = observed.clone();
    wrong_window.window_id = "window-b".to_owned();
    assert!(reduce_observed_window_placement(&current, 4, 11, &wrong_window).is_none());
}

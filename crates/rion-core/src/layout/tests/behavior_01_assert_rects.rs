use super::*;
    use crate::model::{LayoutDividerInput, LayoutRect, LayoutRoleInput};

    fn assert_rects(actual: &[LayoutRect], expected: &[[f64; 4]]) {
        assert_eq!(actual.len(), expected.len());
        for (rect, [x, y, width, height]) in actual.iter().zip(expected) {
            assert_eq!(
                [rect.x, rect.y, rect.width, rect.height],
                [*x, *y, *width, *height]
            );
        }
    }

    #[test]
    fn resolves_visibility_role_bounds_and_divider_geometry() {
        let output = resolve(&WorkspaceLayoutInput {
            active: true,
            hidden: false,
            window_visible: true,
            content_bounds: LayoutBounds {
                x: 0,
                y: 40,
                width: 1000,
                height: 600,
            },
            gap: 4,
            roles: vec![
                LayoutRoleInput {
                    role_id: "a".to_owned(),
                    rect: LayoutRect {
                        x: 0.0,
                        y: 0.0,
                        width: 0.5,
                        height: 1.0,
                    },
                },
                LayoutRoleInput {
                    role_id: "b".to_owned(),
                    rect: LayoutRect {
                        x: 0.5,
                        y: 0.0,
                        width: 0.5,
                        height: 1.0,
                    },
                },
            ],
            dividers: vec![LayoutDividerInput {
                axis: "vertical".to_owned(),
                before_role_ids: vec!["a".to_owned()],
                after_role_ids: vec!["b".to_owned()],
            }],
        });
        assert!(output.visible);
        assert_eq!(output.roles[0].bounds.width, 498);
        assert_eq!(output.roles[1].bounds.x, 502);
        assert_eq!(
            output.dividers[0].bounds,
            LayoutBounds {
                x: 498,
                y: 40,
                width: 4,
                height: 600
            }
        );
    }

    #[test]
    fn resolves_adaptive_zoom_with_hysteresis() {
        crate::v1_case!("browser-workspace-1123d2ecdfda", {
            assert_eq!(adaptive_zoom_percent(1.0, None), 25);
        });
        crate::v1_case!("browser-workspace-eb52e01afc63", {
            assert_eq!(adaptive_zoom_percent(371.0, None), 25);
        });
        crate::v1_case!("browser-workspace-ea042a9959b1", {
            assert_eq!(adaptive_zoom_percent(372.0, None), 33);
        });
        crate::v1_case!("browser-workspace-8becfde663cb", {
            assert_eq!(adaptive_zoom_percent(531.0, None), 33);
        });
        crate::v1_case!("browser-workspace-3ee311675951", {
            assert_eq!(adaptive_zoom_percent(532.0, None), 50);
        });
        crate::v1_case!("browser-workspace-6253d3b7bd01", {
            assert_eq!(adaptive_zoom_percent(748.0, None), 50);
        });
        crate::v1_case!("browser-workspace-1b428ba7ff51", {
            assert_eq!(adaptive_zoom_percent(749.0, None), 67);
        });
        crate::v1_case!("browser-workspace-c45aa11e5117", {
            assert_eq!(adaptive_zoom_percent(908.0, None), 67);
        });
        crate::v1_case!("browser-workspace-8554abf0a66a", {
            assert_eq!(adaptive_zoom_percent(909.0, None), 75);
        });
        crate::v1_case!("browser-workspace-ab6e9af491e5", {
            assert_eq!(adaptive_zoom_percent(991.0, None), 75);
        });
        crate::v1_case!("browser-workspace-d95327781f0d", {
            assert_eq!(adaptive_zoom_percent(992.0, None), 80);
        });
        crate::v1_case!("browser-workspace-c5fd948d8da0", {
            assert_eq!(adaptive_zoom_percent(1_087.0, None), 80);
        });
        crate::v1_case!("browser-workspace-fb71184c9053", {
            assert_eq!(adaptive_zoom_percent(1_088.0, None), 90);
        });
        crate::v1_case!("browser-workspace-110e30ab5cb6", {
            assert_eq!(adaptive_zoom_percent(1_215.0, None), 90);
        });
        crate::v1_case!("browser-workspace-b40350994824", {
            assert_eq!(adaptive_zoom_percent(1_216.0, None), 100);
        });
        crate::v1_case!("browser-workspace-b28f8f5c69ee", {
            assert_eq!(adaptive_zoom_percent(1_278.0, None), 100);
        });
        crate::v1_case!("browser-workspace-3f10abf46fe2", {
            assert_eq!(adaptive_zoom_percent(1_343.0, None), 100);
        });
        crate::v1_case!("browser-workspace-117a545e853d", {
            assert_eq!(adaptive_zoom_percent(1_344.0, None), 110);
        });
        crate::v1_case!("browser-workspace-23eb51b6873e", {
            assert_eq!(adaptive_zoom_percent(1_503.0, None), 110);
        });
        crate::v1_case!("browser-workspace-144aa4d30ef3", {
            assert_eq!(adaptive_zoom_percent(1_504.0, None), 125);
        });
        crate::v1_case!("browser-workspace-86b633230184", {
            assert_eq!(adaptive_zoom_percent(2_560.0, None), 125);
        });
        crate::v1_case!("browser-workspace-df118bf48954", {
            assert_eq!(adaptive_zoom_percent(372.0, Some(25)), 25);
            assert_eq!(adaptive_zoom_percent(383.0, Some(25)), 25);
            assert_eq!(adaptive_zoom_percent(384.0, Some(25)), 33);
            assert_eq!(adaptive_zoom_percent(371.0, Some(33)), 33);
            assert_eq!(adaptive_zoom_percent(360.0, Some(33)), 33);
            assert_eq!(adaptive_zoom_percent(359.0, Some(33)), 25);
        });
        crate::v1_case!("browser-workspace-0873cbdc898e", {
            assert_eq!(adaptive_zoom_percent(f64::NAN, None), 100);
            assert_eq!(adaptive_zoom_percent(0.0, Some(67)), 67);
        });
    }

    #[test]
    fn normalizes_touching_and_persisted_rect_edges_to_one_authoritative_value() {
        let high_precision = normalize_rect_edges(&[
            LayoutRect {
                x: 0.0,
                y: 0.0,
                width: 0.333_333_333,
                height: 1.0,
            },
            LayoutRect {
                x: 0.333_333_334,
                y: 0.0,
                width: 0.666_666_666,
                height: 1.0,
            },
        ]);
        assert_eq!(high_precision[0].width, 0.3333);
        assert_eq!(high_precision[1].x, 0.3333);
        assert_eq!(high_precision[1].width, 0.6667);

        let persisted = vec![
            LayoutRect {
                x: 0.0,
                y: 0.0,
                width: 0.3333,
                height: 1.0,
            },
            LayoutRect {
                x: 0.3333,
                y: 0.0,
                width: 0.3333,
                height: 1.0,
            },
            LayoutRect {
                x: 0.6667,
                y: 0.0,
                width: 0.3333,
                height: 1.0,
            },
        ];
        let normalized = normalize_rect_edges(&persisted);
        crate::v1_case!("browser-workspace-725f43d25113", {
            assert_rects(
                &normalized,
                &[
                    [0.0, 0.0, 0.3333, 1.0],
                    [0.3333, 0.0, 0.3334, 1.0],
                    [0.6667, 0.0, 0.3333, 1.0],
                ],
            );
            assert_eq!(persisted[1].width, 0.3333);
        });

        crate::v1_case!("browser-workspace-a4bda3b1af37", {
            let normalized = normalize_rect_edges(&[
                LayoutRect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.5,
                    height: 0.4999,
                },
                LayoutRect {
                    x: 0.5,
                    y: 0.0,
                    width: 0.5,
                    height: 0.5,
                },
                LayoutRect {
                    x: 0.0,
                    y: 0.5,
                    width: 1.0,
                    height: 0.5,
                },
            ]);
            assert_rects(
                &normalized,
                &[
                    [0.0, 0.0, 0.5, 0.5],
                    [0.5, 0.0, 0.5, 0.5],
                    [0.0, 0.5, 1.0, 0.5],
                ],
            );
        });

        crate::v1_case!("browser-workspace-9b815e24c436", {
            let gapped = vec![
                LayoutRect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.6665,
                    height: 1.0,
                },
                LayoutRect {
                    x: 0.6667,
                    y: 0.0,
                    width: 0.3333,
                    height: 1.0,
                },
            ];
            assert_rects(
                &normalize_rect_edges(&gapped),
                &[[0.0, 0.0, 0.6665, 1.0], [0.6667, 0.0, 0.3333, 1.0]],
            );
        });
    }

    #[test]
    fn creates_and_resizes_workspace_dividers() {
        let roles = vec![
            LayoutRoleInput {
                role_id: "a".to_owned(),
                rect: LayoutRect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.5,
                    height: 1.0,
                },
            },
            LayoutRoleInput {
                role_id: "b".to_owned(),
                rect: LayoutRect {
                    x: 0.5,
                    y: 0.0,
                    width: 0.5,
                    height: 1.0,
                },
            },
        ];
        let dividers = create_dividers(&roles);
        assert_eq!(dividers.len(), 1);
        assert_eq!(dividers[0].before_role_ids, vec!["a"]);
        assert_eq!(dividers[0].after_role_ids, vec!["b"]);
        let output = resize_divider(&WorkspaceDividerResizeInput {
            roles,
            dividers,
            divider_index: 0,
            requested_position: 0.574,
            previous_position: None,
        })
        .expect("divider resize");
        assert!(output.changed);
        assert_eq!(output.position, 0.55);
        assert_eq!(output.roles[0].rect.width, 0.55);
        assert_eq!(output.roles[1].rect.x, 0.55);
        assert!((output.roles[1].rect.width - 0.45).abs() < DIVIDER_EPSILON);
    }

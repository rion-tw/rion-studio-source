use crate::{PixelBounds, PlatformError};

pub(crate) const MAX_ALIGNMENT_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowAlignmentReport {
    pub visible: PixelBounds,
    pub attempts: usize,
    pub dpi: u32,
}

pub(crate) trait WindowFrameBackend {
    fn read_visible_bounds(&mut self) -> Result<PixelBounds, PlatformError>;
    fn read_outer_bounds(&mut self) -> Result<PixelBounds, PlatformError>;
    fn set_outer_bounds(&mut self, bounds: PixelBounds) -> Result<(), PlatformError>;
    fn read_dpi(&mut self) -> Result<u32, PlatformError>;
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WindowCandidateMetadata {
    pub visible: PixelBounds,
    pub is_chrome_widget: bool,
    pub is_ownerless: bool,
}

pub(crate) fn compute_adjusted_outer(
    outer: PixelBounds,
    visible: PixelBounds,
    target: PixelBounds,
) -> Result<PixelBounds, PlatformError> {
    let (outer_right, outer_bottom) = edges(outer)?;
    let (visible_right, visible_bottom) = edges(visible)?;
    let (target_right, target_bottom) = edges(target)?;
    let left = i64::from(outer.x) + i64::from(target.x) - i64::from(visible.x);
    let top = i64::from(outer.y) + i64::from(target.y) - i64::from(visible.y);
    let right = outer_right + target_right - visible_right;
    let bottom = outer_bottom + target_bottom - visible_bottom;
    let width = right - left;
    let height = bottom - top;
    if width <= 0 || height <= 0 {
        return Err(PlatformError::Operation(
            "corrected window frame has an invalid size".to_owned(),
        ));
    }
    Ok(PixelBounds {
        x: to_i32(left)?,
        y: to_i32(top)?,
        width: to_i32(width)?,
        height: to_i32(height)?,
    })
}

pub(crate) fn align_visible_frame_with_backend(
    process_id: u32,
    target: PixelBounds,
    backend: &mut impl WindowFrameBackend,
) -> Result<WindowAlignmentReport, PlatformError> {
    let target = validate_alignment_request(process_id, target)?;
    let mut visible = backend.read_visible_bounds()?;
    if visible == target {
        return finish_alignment(visible, 0, backend);
    }
    for attempt in 1..=MAX_ALIGNMENT_ATTEMPTS {
        let outer = backend.read_outer_bounds()?;
        let outer_target = compute_adjusted_outer(outer, visible, target)?;
        backend.set_outer_bounds(outer_target)?;
        visible = backend.read_visible_bounds()?;
        if visible == target {
            return finish_alignment(visible, attempt, backend);
        }
    }
    Err(PlatformError::Operation(
        "visible frame did not reach the exact target after three attempts".to_owned(),
    ))
}

pub(crate) fn validate_alignment_request(
    process_id: u32,
    target: PixelBounds,
) -> Result<PixelBounds, PlatformError> {
    if process_id == 0 {
        return Err(PlatformError::Operation(
            "browser process id must be positive".to_owned(),
        ));
    }
    target.validate()
}

pub(crate) fn candidate_matches_process(expected: u32, actual: u32) -> bool {
    expected != 0 && expected == actual
}

fn finish_alignment(
    visible: PixelBounds,
    attempts: usize,
    backend: &mut impl WindowFrameBackend,
) -> Result<WindowAlignmentReport, PlatformError> {
    let dpi = backend.read_dpi()?;
    if dpi == 0 {
        return Err(PlatformError::Operation(
            "window DPI must be positive".to_owned(),
        ));
    }
    Ok(WindowAlignmentReport {
        visible,
        attempts,
        dpi,
    })
}

pub(crate) fn select_best_candidate(
    candidates: &[WindowCandidateMetadata],
    target: PixelBounds,
) -> Result<Option<usize>, PlatformError> {
    target.validate()?;
    let mut best: Option<(usize, (i64, bool, bool))> = None;
    let mut ambiguous = false;
    for (index, candidate) in candidates.iter().enumerate() {
        let rank = (
            intersection_area(candidate.visible, target),
            candidate.is_chrome_widget,
            candidate.is_ownerless,
        );
        match best {
            None => {
                best = Some((index, rank));
                ambiguous = false;
            }
            Some((_, best_rank)) if rank > best_rank => {
                best = Some((index, rank));
                ambiguous = false;
            }
            Some((_, best_rank)) if rank == best_rank => ambiguous = true,
            Some(_) => {}
        }
    }
    if ambiguous {
        return Err(PlatformError::Operation(
            "multiple equally ranked external Chrome windows were found".to_owned(),
        ));
    }
    Ok(best.map(|(index, _)| index))
}

fn intersection_area(left: PixelBounds, right: PixelBounds) -> i64 {
    let Ok((left_right, left_bottom)) = edges(left) else {
        return 0;
    };
    let Ok((right_right, right_bottom)) = edges(right) else {
        return 0;
    };
    let width = (left_right.min(right_right) - i64::from(left.x.max(right.x))).max(0);
    let height = (left_bottom.min(right_bottom) - i64::from(left.y.max(right.y))).max(0);
    width.saturating_mul(height)
}

fn edges(bounds: PixelBounds) -> Result<(i64, i64), PlatformError> {
    bounds.validate()?;
    let right = i64::from(bounds.x) + i64::from(bounds.width);
    let bottom = i64::from(bounds.y) + i64::from(bounds.height);
    let _ = (to_i32(right)?, to_i32(bottom)?);
    Ok((right, bottom))
}

fn to_i32(value: i64) -> Result<i32, PlatformError> {
    i32::try_from(value).map_err(|_| {
        PlatformError::Operation("corrected window frame exceeds int32 geometry".to_owned())
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    struct FakeBackend {
        visible: VecDeque<Result<PixelBounds, PlatformError>>,
        outer: Result<PixelBounds, String>,
        dpi: Result<u32, String>,
        set_error: Option<String>,
        calls: Vec<(&'static str, Option<PixelBounds>)>,
    }

    impl FakeBackend {
        fn aligned(target: PixelBounds) -> Self {
            Self {
                visible: VecDeque::from([Ok(target)]),
                outer: Ok(target),
                dpi: Ok(120),
                set_error: None,
                calls: Vec::new(),
            }
        }

        fn with_visible(values: impl IntoIterator<Item = PixelBounds>, outer: PixelBounds) -> Self {
            Self {
                visible: values.into_iter().map(Ok).collect(),
                outer: Ok(outer),
                dpi: Ok(120),
                set_error: None,
                calls: Vec::new(),
            }
        }

        fn failing_visible(message: &str) -> Self {
            Self {
                visible: VecDeque::from([Err(PlatformError::Operation(message.to_owned()))]),
                outer: Err("outer bounds unavailable".to_owned()),
                dpi: Ok(120),
                set_error: None,
                calls: Vec::new(),
            }
        }
    }

    impl WindowFrameBackend for FakeBackend {
        fn read_visible_bounds(&mut self) -> Result<PixelBounds, PlatformError> {
            self.calls.push(("visible", None));
            self.visible.pop_front().unwrap_or_else(|| {
                Err(PlatformError::Operation(
                    "visible bounds fixture exhausted".to_owned(),
                ))
            })
        }

        fn read_outer_bounds(&mut self) -> Result<PixelBounds, PlatformError> {
            self.calls.push(("outer", None));
            self.outer
                .as_ref()
                .copied()
                .map_err(|message| PlatformError::Operation(message.to_owned()))
        }

        fn set_outer_bounds(&mut self, bounds: PixelBounds) -> Result<(), PlatformError> {
            self.calls.push(("set", Some(bounds)));
            self.set_error.as_ref().map_or(Ok(()), |message| {
                Err(PlatformError::Operation(message.clone()))
            })
        }

        fn read_dpi(&mut self) -> Result<u32, PlatformError> {
            self.calls.push(("dpi", None));
            self.dpi
                .as_ref()
                .map(|dpi| *dpi)
                .map_err(|message| PlatformError::Operation(message.clone()))
        }
    }

    fn target() -> PixelBounds {
        PixelBounds {
            x: -1_920,
            y: 0,
            width: 1_920,
            height: 1_040,
        }
    }

    fn outer() -> PixelBounds {
        PixelBounds {
            x: -1_928,
            y: -8,
            width: 1_936,
            height: 1_056,
        }
    }

    fn gapped() -> PixelBounds {
        PixelBounds {
            x: -1_912,
            y: 0,
            width: 1_904,
            height: 1_040,
        }
    }

    #[test]
    fn adjusts_each_outer_edge_from_the_visible_frame_delta() {
        let outer = PixelBounds {
            x: 90,
            y: 80,
            width: 1_020,
            height: 840,
        };
        let visible = PixelBounds {
            x: 100,
            y: 100,
            width: 1_000,
            height: 800,
        };
        let target = PixelBounds {
            x: -1_920,
            y: 0,
            width: 1_920,
            height: 1_040,
        };
        assert_eq!(
            compute_adjusted_outer(outer, visible, target).unwrap(),
            PixelBounds {
                x: -1_930,
                y: -20,
                width: 1_940,
                height: 1_080,
            }
        );
    }

    #[test]
    fn ranks_intersection_then_chrome_class_then_ownerless_state() {
        let target = PixelBounds {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        };
        let candidates = [
            WindowCandidateMetadata {
                visible: target,
                is_chrome_widget: false,
                is_ownerless: true,
            },
            WindowCandidateMetadata {
                visible: target,
                is_chrome_widget: true,
                is_ownerless: false,
            },
        ];
        assert_eq!(select_best_candidate(&candidates, target).unwrap(), Some(1));
    }

    #[test]
    fn rejects_ambiguous_and_overflowing_geometry() {
        let target = PixelBounds {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        };
        let candidate = WindowCandidateMetadata {
            visible: target,
            is_chrome_widget: true,
            is_ownerless: true,
        };
        assert!(select_best_candidate(&[candidate, candidate], target).is_err());
        assert!(
            compute_adjusted_outer(
                PixelBounds {
                    x: i32::MAX,
                    y: 0,
                    width: 100,
                    height: 100,
                },
                target,
                target,
            )
            .is_err()
        );
    }

    #[test]
    fn v1_windows_alignment_contracts_use_the_typed_in_process_backend() {
        crate::v1_case!("resource-platform-01b5edb57911", {
            let mut backend = FakeBackend::with_visible([gapped(), target()], outer());
            let report = align_visible_frame_with_backend(4_321, target(), &mut backend).unwrap();
            assert_eq!(report.visible, target());
            assert_eq!(report.attempts, 1);
            assert_eq!(report.dpi, 120);
            assert_eq!(
                backend
                    .calls
                    .iter()
                    .filter(|(call, _)| *call == "set")
                    .map(|(_, bounds)| bounds.expect("set call carries bounds"))
                    .collect::<Vec<_>>(),
                vec![compute_adjusted_outer(outer(), gapped(), target()).unwrap()]
            );
        });

        crate::v1_case!("resource-platform-7ba64053873a", {
            let mut backend = FakeBackend::aligned(target());
            let report = align_visible_frame_with_backend(12, target(), &mut backend).unwrap();
            assert_eq!(report.visible, target());
            assert_eq!(backend.calls, vec![("visible", None), ("dpi", None)]);
        });

        crate::v1_case!("resource-platform-69c206a00ece", {
            let mut backend = FakeBackend::with_visible([gapped(), target()], outer());
            assert!(
                align_visible_frame_with_backend(12, target(), &mut backend).is_ok(),
                "the in-process adapter must not depend on a helper executable path"
            );
        });

        for (case_id, message) in [
            ("resource-platform-cc81e6906c62", "invalid JSON"),
            ("resource-platform-8129176331e6", "invalid output"),
            ("resource-platform-e552b0c3c95a", "unsupported protocol"),
            (
                "resource-platform-28116ce41158",
                "successful response required",
            ),
        ] {
            let mut backend = FakeBackend::failing_visible(message);
            let error = align_visible_frame_with_backend(12, target(), &mut backend).unwrap_err();
            match case_id {
                "resource-platform-cc81e6906c62" => {
                    crate::v1_case!("resource-platform-cc81e6906c62", {
                        assert!(error.to_string().contains("invalid JSON"));
                    });
                }
                "resource-platform-8129176331e6" => {
                    crate::v1_case!("resource-platform-8129176331e6", {
                        assert!(error.to_string().contains("invalid output"));
                    });
                }
                "resource-platform-e552b0c3c95a" => {
                    crate::v1_case!("resource-platform-e552b0c3c95a", {
                        assert!(error.to_string().contains("unsupported protocol"));
                    });
                }
                _ => {
                    crate::v1_case!("resource-platform-28116ce41158", {
                        assert!(error.to_string().contains("successful response"));
                    });
                }
            }
        }

        crate::v1_case!("resource-platform-89450c568fde", {
            let mut backend = FakeBackend::aligned(target());
            let error = align_visible_frame_with_backend(0, target(), &mut backend).unwrap_err();
            assert!(error.to_string().contains("process id must be positive"));
            assert!(backend.calls.is_empty());
        });

        crate::v1_case!("resource-platform-102d470c43bc", {
            let mut backend = FakeBackend::failing_visible("invalid window handle");
            let error = align_visible_frame_with_backend(12, target(), &mut backend).unwrap_err();
            assert!(error.to_string().contains("invalid window handle"));
        });

        crate::v1_case!("resource-platform-e9bebde723c6", {
            let mut backend = FakeBackend::aligned(target());
            backend.dpi = Ok(0);
            let error = align_visible_frame_with_backend(12, target(), &mut backend).unwrap_err();
            assert!(error.to_string().contains("window DPI must be positive"));
        });

        crate::v1_case!("resource-platform-5341d268af13", {
            let mut backend = FakeBackend::failing_visible("visible frame is unavailable");
            let error = align_visible_frame_with_backend(12, target(), &mut backend).unwrap_err();
            assert!(error.to_string().contains("visible frame is unavailable"));
        });

        crate::v1_case!("resource-platform-9bf07b5fee36", {
            let mut backend =
                FakeBackend::with_visible([gapped(), gapped(), gapped(), gapped()], outer());
            let error = align_visible_frame_with_backend(12, target(), &mut backend).unwrap_err();
            assert!(error.to_string().contains("after three attempts"));
            assert_eq!(
                backend
                    .calls
                    .iter()
                    .filter(|(call, _)| *call == "set")
                    .count(),
                MAX_ALIGNMENT_ATTEMPTS
            );
        });

        crate::v1_case!("resource-platform-8a54d772a27e", {
            let different_target = PixelBounds {
                width: target().width - 1,
                ..target()
            };
            let mut backend = FakeBackend::with_visible(
                [
                    gapped(),
                    different_target,
                    different_target,
                    different_target,
                ],
                outer(),
            );
            let error = align_visible_frame_with_backend(12, target(), &mut backend).unwrap_err();
            assert!(error.to_string().contains("exact target"));
        });

        crate::v1_case!("resource-platform-856facc2ead6", {
            assert!(candidate_matches_process(12, 12));
            assert!(!candidate_matches_process(12, 99));
            assert!(!candidate_matches_process(0, 0));
        });

        crate::v1_case!("resource-platform-e0fb56fa1d86", {
            let mut backend =
                FakeBackend::with_visible([gapped(), gapped(), gapped(), gapped()], outer());
            let error = align_visible_frame_with_backend(12, target(), &mut backend).unwrap_err();
            assert!(error.to_string().contains("visible frame did not reach"));
        });

        crate::v1_case!("resource-platform-e05a9905d2a6", {
            let mut invalid_pid = FakeBackend::aligned(target());
            assert!(align_visible_frame_with_backend(0, target(), &mut invalid_pid).is_err());
            assert!(invalid_pid.calls.is_empty());

            let mut invalid_bounds = FakeBackend::aligned(target());
            assert!(
                align_visible_frame_with_backend(
                    12,
                    PixelBounds {
                        width: 0,
                        ..target()
                    },
                    &mut invalid_bounds,
                )
                .is_err()
            );
            assert!(invalid_bounds.calls.is_empty());
        });

        for (case_id, message) in [
            ("resource-platform-2d7353cce471", "helper timed out"),
            (
                "resource-platform-b7f8ac6030ad",
                "helper exited with code 4",
            ),
        ] {
            let mut backend = FakeBackend::with_visible([gapped()], outer());
            backend.set_error = Some(message.to_owned());
            let error = align_visible_frame_with_backend(12, target(), &mut backend).unwrap_err();
            match case_id {
                "resource-platform-2d7353cce471" => {
                    crate::v1_case!("resource-platform-2d7353cce471", {
                        assert!(error.to_string().contains("helper timed out"));
                    });
                }
                _ => {
                    crate::v1_case!("resource-platform-b7f8ac6030ad", {
                        assert!(error.to_string().contains("helper exited with code 4"));
                    });
                }
            }
        }

        crate::v1_case!("resource-platform-c624cb2bd825", {
            let mut backend = FakeBackend::aligned(target());
            let report = align_visible_frame_with_backend(12, target(), &mut backend).unwrap();
            assert_eq!(report.visible, target());
            assert_eq!(report.attempts, 0);
            assert!(
                backend
                    .calls
                    .iter()
                    .all(|(call, _)| matches!(*call, "visible" | "dpi")),
                "the Rust adapter must complete without an external manifest-backed helper"
            );
        });
    }
}

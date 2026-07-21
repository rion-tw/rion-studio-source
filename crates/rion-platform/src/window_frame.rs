use crate::{PixelBounds, PlatformError};

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
    use super::*;

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
}

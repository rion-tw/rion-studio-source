use std::collections::HashMap;

use crate::model::{
    LayoutBounds, LayoutDividerBounds, LayoutRoleBounds, WorkspaceLayoutInput,
    WorkspaceLayoutOutput,
};

pub fn resolve(input: &WorkspaceLayoutInput) -> WorkspaceLayoutOutput {
    let visible = input.active && !input.hidden && input.window_visible;
    let before_inset = (input.gap / 2) as i32;
    let after_inset = input.gap as i32 - before_inset;
    let role_rects = input
        .roles
        .iter()
        .map(|role| (role.role_id.as_str(), &role.rect))
        .collect::<HashMap<_, _>>();
    let roles = input
        .roles
        .iter()
        .map(|role| {
            let mut bounds = normalized_bounds(&role.rect, &input.content_bounds);
            for divider in &input.dividers {
                if divider.axis == "vertical" {
                    if divider.before_role_ids.contains(&role.role_id) {
                        bounds.width -= before_inset;
                    }
                    if divider.after_role_ids.contains(&role.role_id) {
                        bounds.x += after_inset;
                        bounds.width -= after_inset;
                    }
                } else {
                    if divider.before_role_ids.contains(&role.role_id) {
                        bounds.height -= before_inset;
                    }
                    if divider.after_role_ids.contains(&role.role_id) {
                        bounds.y += after_inset;
                        bounds.height -= after_inset;
                    }
                }
            }
            bounds.width = bounds.width.max(1);
            bounds.height = bounds.height.max(1);
            LayoutRoleBounds {
                role_id: role.role_id.clone(),
                bounds,
            }
        })
        .collect();
    let dividers = input
        .dividers
        .iter()
        .enumerate()
        .filter_map(|(index, divider)| {
            let before = divider
                .before_role_ids
                .iter()
                .filter_map(|role_id| role_rects.get(role_id.as_str()).copied())
                .collect::<Vec<_>>();
            let after = divider
                .after_role_ids
                .iter()
                .filter_map(|role_id| role_rects.get(role_id.as_str()).copied())
                .collect::<Vec<_>>();
            if before.is_empty() || after.is_empty() {
                return None;
            }
            let all = before
                .iter()
                .chain(after.iter())
                .copied()
                .collect::<Vec<_>>();
            let vertical = divider.axis == "vertical";
            let position = if vertical { after[0].x } else { after[0].y };
            let start = all
                .iter()
                .map(|rect| if vertical { rect.y } else { rect.x })
                .fold(f64::INFINITY, f64::min);
            let end = all
                .iter()
                .map(|rect| {
                    if vertical {
                        rect.y + rect.height
                    } else {
                        rect.x + rect.width
                    }
                })
                .fold(f64::NEG_INFINITY, f64::max);
            let bounds = if vertical {
                let line = (position * f64::from(input.content_bounds.width)).round() as i32;
                let top = (start * f64::from(input.content_bounds.height)).round() as i32;
                let bottom = (end * f64::from(input.content_bounds.height)).round() as i32;
                LayoutBounds {
                    x: input.content_bounds.x + line - before_inset,
                    y: input.content_bounds.y + top,
                    width: input.gap as i32,
                    height: (bottom - top).max(1),
                }
            } else {
                let line = (position * f64::from(input.content_bounds.height)).round() as i32;
                let left = (start * f64::from(input.content_bounds.width)).round() as i32;
                let right = (end * f64::from(input.content_bounds.width)).round() as i32;
                LayoutBounds {
                    x: input.content_bounds.x + left,
                    y: input.content_bounds.y + line - before_inset,
                    width: (right - left).max(1),
                    height: input.gap as i32,
                }
            };
            Some(LayoutDividerBounds {
                index: index as u32,
                bounds,
            })
        })
        .collect();
    WorkspaceLayoutOutput {
        visible,
        roles,
        dividers,
    }
}

fn normalized_bounds(rect: &crate::model::LayoutRect, content: &LayoutBounds) -> LayoutBounds {
    let left = (rect.x * f64::from(content.width)).round() as i32;
    let top = (rect.y * f64::from(content.height)).round() as i32;
    let right = ((rect.x + rect.width) * f64::from(content.width)).round() as i32;
    let bottom = ((rect.y + rect.height) * f64::from(content.height)).round() as i32;
    LayoutBounds {
        x: content.x + left,
        y: content.y + top,
        width: (right - left).max(1),
        height: (bottom - top).max(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{LayoutDividerInput, LayoutRect, LayoutRoleInput};

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
}

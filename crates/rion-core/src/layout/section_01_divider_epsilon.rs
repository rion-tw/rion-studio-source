use std::collections::HashMap;

use crate::model::{
    LayoutBounds, LayoutDividerBounds, LayoutRect, LayoutRoleBounds, LayoutRoleInput,
    WorkspaceDividerDescriptor, WorkspaceDividerResizeInput, WorkspaceDividerResizeOutput,
    WorkspaceLayoutInput, WorkspaceLayoutOutput,
};

const DIVIDER_EPSILON: f64 = 0.000_001;
const MIN_WORKSPACE_SLOT_SIZE: f64 = 0.12;
const RECT_EDGE_TOLERANCE: f64 = 0.000_1;
const RECT_PRECISION_SCALE: f64 = 10_000.0;
const RESIZE_SNAP_STEP: f64 = 0.05;
const RESIZE_SWITCH_TOLERANCE: f64 = 0.001;
const ADAPTIVE_ZOOM_HYSTERESIS_DIP: f64 = 12.0;
const ADAPTIVE_ZOOM_THRESHOLDS: &[(f64, u32)] = &[
    (0.0, 25),
    (372.0, 33),
    (532.0, 50),
    (749.0, 67),
    (909.0, 75),
    (992.0, 80),
    (1_088.0, 90),
    (1_216.0, 100),
    (1_344.0, 110),
    (1_504.0, 125),
];

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

pub fn adaptive_zoom_percent(viewport_width: f64, current_percent: Option<u32>) -> u32 {
    if !viewport_width.is_finite() || viewport_width <= 0.0 {
        return current_percent.unwrap_or(100);
    }

    let target_index = ADAPTIVE_ZOOM_THRESHOLDS
        .iter()
        .rposition(|(min_width, _)| viewport_width >= *min_width)
        .unwrap_or(0);
    let Some(current_percent) = current_percent else {
        return ADAPTIVE_ZOOM_THRESHOLDS[target_index].1;
    };
    let Some(current_index) = ADAPTIVE_ZOOM_THRESHOLDS
        .iter()
        .position(|(_, percent)| *percent == current_percent)
    else {
        return ADAPTIVE_ZOOM_THRESHOLDS[target_index].1;
    };
    if current_index == target_index {
        return current_percent;
    }

    if target_index > current_index {
        if let Some((next_threshold, _)) = ADAPTIVE_ZOOM_THRESHOLDS.get(current_index + 1)
            && viewport_width < next_threshold + ADAPTIVE_ZOOM_HYSTERESIS_DIP
        {
            return current_percent;
        }
    } else if viewport_width
        >= ADAPTIVE_ZOOM_THRESHOLDS[current_index].0 - ADAPTIVE_ZOOM_HYSTERESIS_DIP
    {
        return current_percent;
    }

    ADAPTIVE_ZOOM_THRESHOLDS[target_index].1
}

pub fn normalize_rect_edges(rects: &[LayoutRect]) -> Vec<LayoutRect> {
    if rects.is_empty() {
        return Vec::new();
    }
    let edges = rects
        .iter()
        .map(|rect| [rect.x, rect.x + rect.width, rect.y, rect.y + rect.height])
        .collect::<Vec<_>>();
    let mut parents = (0..edges.len() * 4).collect::<Vec<_>>();

    for left_index in 0..edges.len() {
        for right_index in left_index + 1..edges.len() {
            let left = edges[left_index];
            let right = edges[right_index];
            let vertical_overlap = left[3].min(right[3]) - left[2].max(right[2]);
            let horizontal_overlap = left[1].min(right[1]) - left[0].max(right[0]);
            if vertical_overlap > 0.0 {
                if edges_touch(left[1], right[0]) {
                    union(&mut parents, left_index * 4 + 1, right_index * 4);
                }
                if edges_touch(right[1], left[0]) {
                    union(&mut parents, right_index * 4 + 1, left_index * 4);
                }
            }
            if horizontal_overlap > 0.0 {
                if edges_touch(left[3], right[2]) {
                    union(&mut parents, left_index * 4 + 3, right_index * 4 + 2);
                }
                if edges_touch(right[3], left[2]) {
                    union(&mut parents, right_index * 4 + 3, left_index * 4 + 2);
                }
            }
        }
    }

    let mut groups = HashMap::<usize, Vec<usize>>::new();
    for index in 0..parents.len() {
        let root = find(&mut parents, index);
        groups.entry(root).or_default().push(index);
    }
    let mut normalized = edges
        .iter()
        .flat_map(|edge| edge.iter())
        .map(|value| (value * RECT_PRECISION_SCALE).round() as i64)
        .collect::<Vec<_>>();
    for group in groups.values().filter(|group| group.len() > 1) {
        let preferred = group
            .iter()
            .copied()
            .filter(|index| matches!(index % 4, 0 | 2))
            .collect::<Vec<_>>();
        let candidates = if preferred.is_empty() {
            group
        } else {
            &preferred
        };
        let value = (candidates
            .iter()
            .map(|index| normalized[*index] as f64)
            .sum::<f64>()
            / candidates.len() as f64)
            .round() as i64;
        for index in group {
            normalized[*index] = value;
        }
    }

    (0..rects.len())
        .map(|index| {
            let offset = index * 4;
            let left = normalized[offset];
            let right = normalized[offset + 1];
            let top = normalized[offset + 2];
            let bottom = normalized[offset + 3];
            LayoutRect {
                x: left as f64 / RECT_PRECISION_SCALE,
                y: top as f64 / RECT_PRECISION_SCALE,
                width: (right - left) as f64 / RECT_PRECISION_SCALE,
                height: (bottom - top) as f64 / RECT_PRECISION_SCALE,
            }
        })
        .collect()
}

pub fn create_dividers(roles: &[LayoutRoleInput]) -> Vec<WorkspaceDividerDescriptor> {
    #[derive(Clone)]
    struct Segment {
        axis: &'static str,
        position: f64,
        start: f64,
        end: f64,
        before_role_id: String,
        after_role_id: String,
    }
    struct Group {
        axis: &'static str,
        position: f64,
        start: f64,
        end: f64,
        before_role_ids: Vec<String>,
        after_role_ids: Vec<String>,
    }

    let mut segments = Vec::<Segment>::new();
    for left_index in 0..roles.len() {
        for right_index in left_index + 1..roles.len() {
            let left = &roles[left_index];
            let right = &roles[right_index];
            add_shared_edge(&mut segments, left, right, "vertical");
            add_shared_edge(&mut segments, right, left, "vertical");
            add_shared_edge(&mut segments, left, right, "horizontal");
            add_shared_edge(&mut segments, right, left, "horizontal");
        }
    }
    segments.sort_by(|left, right| {
        let left_axis = if left.axis == "vertical" { 0 } else { 1 };
        let right_axis = if right.axis == "vertical" { 0 } else { 1 };
        left_axis
            .cmp(&right_axis)
            .then_with(|| left.position.total_cmp(&right.position))
            .then_with(|| left.start.total_cmp(&right.start))
    });

    let mut groups = Vec::<Group>::new();
    for segment in segments {
        if let Some(group) = groups.iter_mut().find(|candidate| {
            candidate.axis == segment.axis
                && (candidate.position - segment.position).abs() < DIVIDER_EPSILON
                && segment.start <= candidate.end + DIVIDER_EPSILON
                && candidate.start <= segment.end + DIVIDER_EPSILON
        }) {
            group.start = group.start.min(segment.start);
            group.end = group.end.max(segment.end);
            push_unique(&mut group.before_role_ids, segment.before_role_id);
            push_unique(&mut group.after_role_ids, segment.after_role_id);
        } else {
            groups.push(Group {
                axis: segment.axis,
                position: segment.position,
                start: segment.start,
                end: segment.end,
                before_role_ids: vec![segment.before_role_id],
                after_role_ids: vec![segment.after_role_id],
            });
        }
    }

    let descriptors = groups
        .into_iter()
        .map(|group| WorkspaceDividerDescriptor {
            axis: group.axis.to_owned(),
            before_role_ids: group.before_role_ids,
            after_role_ids: group.after_role_ids,
            default_position: group.position,
        })
        .collect();

    fn add_shared_edge(
        segments: &mut Vec<Segment>,
        before: &LayoutRoleInput,
        after: &LayoutRoleInput,
        axis: &'static str,
    ) {
        let vertical = axis == "vertical";
        let position = if vertical {
            before.rect.x + before.rect.width
        } else {
            before.rect.y + before.rect.height
        };
        let after_position = if vertical { after.rect.x } else { after.rect.y };
        if (position - after_position).abs() >= DIVIDER_EPSILON {
            return;
        }
        let before_start = if vertical {
            before.rect.y
        } else {
            before.rect.x
        };
        let before_end = before_start
            + if vertical {
                before.rect.height
            } else {
                before.rect.width
            };
        let after_start = if vertical { after.rect.y } else { after.rect.x };
        let after_end = after_start
            + if vertical {
                after.rect.height
            } else {
                after.rect.width
            };
        let start = before_start.max(after_start);
        let end = before_end.min(after_end);
        if end - start <= DIVIDER_EPSILON {
            return;
        }
        segments.push(Segment {
            axis,
            position,
            start,
            end,
            before_role_id: before.role_id.clone(),
            after_role_id: after.role_id.clone(),
        });
    }

    descriptors
}

pub fn resize_divider(input: &WorkspaceDividerResizeInput) -> Option<WorkspaceDividerResizeOutput> {
    let divider = input.dividers.get(input.divider_index as usize)?;
    let linked = input.dividers.iter().filter(|candidate| {
        candidate.axis == divider.axis
            && (candidate.default_position - divider.default_position).abs() < DIVIDER_EPSILON
    });
    let mut before_role_ids = Vec::new();
    let mut after_role_ids = Vec::new();
    for candidate in linked {
        for role_id in &candidate.before_role_ids {
            push_unique(&mut before_role_ids, role_id.clone());
        }
        for role_id in &candidate.after_role_ids {
            push_unique(&mut after_role_ids, role_id.clone());
        }
    }
    let roles_by_id = input
        .roles
        .iter()
        .map(|role| (role.role_id.as_str(), role))
        .collect::<HashMap<_, _>>();
    let before = before_role_ids
        .iter()
        .filter_map(|role_id| roles_by_id.get(role_id.as_str()).copied())
        .collect::<Vec<_>>();
    let after = after_role_ids
        .iter()
        .filter_map(|role_id| roles_by_id.get(role_id.as_str()).copied())
        .collect::<Vec<_>>();
    if before.is_empty() || after.is_empty() {
        return None;
    }
    let vertical = divider.axis == "vertical";
    let start = |role: &LayoutRoleInput| if vertical { role.rect.x } else { role.rect.y };
    let size = |role: &LayoutRoleInput| {
        if vertical {
            role.rect.width
        } else {
            role.rect.height
        }
    };
    let min = before
        .iter()
        .map(|role| start(role) + MIN_WORKSPACE_SLOT_SIZE)
        .fold(f64::NEG_INFINITY, f64::max);
    let max = after
        .iter()
        .map(|role| start(role) + size(role) - MIN_WORKSPACE_SLOT_SIZE)
        .fold(f64::INFINITY, f64::min);
    let current_position = start(after[0]);
    let position = snap_resize_position(
        input.requested_position,
        min,
        max,
        divider.default_position,
        input.previous_position,
    );
    let mut role_ids = before_role_ids.clone();
    for role_id in &after_role_ids {
        push_unique(&mut role_ids, role_id.clone());
    }
    let changed = (position - current_position).abs() >= DIVIDER_EPSILON;
    let mut roles = input.roles.clone();
    if changed {
        for role in &mut roles {
            if before_role_ids.contains(&role.role_id) {
                if vertical {
                    role.rect.width = position - role.rect.x;
                } else {
                    role.rect.height = position - role.rect.y;
                }
            } else if after_role_ids.contains(&role.role_id) {
                if vertical {
                    let end = role.rect.x + role.rect.width;
                    role.rect.x = position;
                    role.rect.width = end - position;
                } else {
                    let end = role.rect.y + role.rect.height;
                    role.rect.y = position;
                    role.rect.height = end - position;
                }
            }
        }
    }
    Some(WorkspaceDividerResizeOutput {
        changed,
        position,
        role_ids,
        roles,
    })
}

fn snap_resize_position(
    requested_position: f64,
    min: f64,
    max: f64,
    initial_position: f64,
    previous_position: Option<f64>,
) -> f64 {
    let (min, max) = (min.min(max), min.max(max));
    let requested = requested_position.clamp(min, max);
    let mut candidates = vec![min, max, initial_position, 1.0 / 3.0, 0.5, 2.0 / 3.0];
    let first_step = ((min - DIVIDER_EPSILON) / RESIZE_SNAP_STEP).ceil() as i64;
    let last_step = ((max + DIVIDER_EPSILON) / RESIZE_SNAP_STEP).floor() as i64;
    for step in first_step..=last_step {
        candidates.push(((step as f64 * RESIZE_SNAP_STEP) * 1_000_000.0).round() / 1_000_000.0);
    }
    candidates.retain(|candidate| {
        *candidate >= min - DIVIDER_EPSILON && *candidate <= max + DIVIDER_EPSILON
    });
    for candidate in &mut candidates {
        *candidate = candidate.clamp(min, max);
    }
    candidates.sort_by(f64::total_cmp);
    candidates.dedup_by(|left, right| (*left - *right).abs() < DIVIDER_EPSILON);
    let mut closest = candidates.first().copied().unwrap_or(requested);
    for candidate in candidates.iter().copied().skip(1) {
        if (requested - candidate).abs() < (requested - closest).abs() - DIVIDER_EPSILON {
            closest = candidate;
        }
    }
    if let Some(previous) = previous_position
        && previous >= min - DIVIDER_EPSILON
        && previous <= max + DIVIDER_EPSILON
        && let Some(previous_candidate) = candidates
            .iter()
            .copied()
            .find(|candidate| (*candidate - previous).abs() < DIVIDER_EPSILON)
        && (requested - previous_candidate).abs()
            <= (requested - closest).abs() + RESIZE_SWITCH_TOLERANCE
    {
        return previous_candidate;
    }
    closest
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn edges_touch(left: f64, right: f64) -> bool {
    (left - right).abs() <= RECT_EDGE_TOLERANCE + f64::EPSILON
}

fn find(parents: &mut [usize], index: usize) -> usize {
    let mut root = index;
    while parents[root] != root {
        root = parents[root];
    }
    let mut current = index;
    while parents[current] != current {
        let parent = parents[current];
        parents[current] = root;
        current = parent;
    }
    root
}

fn union(parents: &mut [usize], left: usize, right: usize) {
    let left_root = find(parents, left);
    let right_root = find(parents, right);
    if left_root != right_root {
        parents[right_root] = left_root;
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

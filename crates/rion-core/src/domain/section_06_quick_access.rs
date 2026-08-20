pub const QUICK_ACCESS_RECENT_LIMIT: usize = 20;

pub fn default_quick_access_preferences() -> QuickAccessPreferencesRecord {
    QuickAccessPreferencesRecord::default()
}

pub fn normalize_quick_access_item(
    item: QuickAccessItemRefRecord,
) -> CoreResult<QuickAccessItemRefRecord> {
    let id = item.id.trim();
    if !matches!(item.kind.as_str(), "role" | "workspace" | "gameWindow" | "macro")
        || id.is_empty()
        || id.len() > 128
    {
        return Err(CoreError::InvalidInput(
            "Quick access item is invalid.".to_owned(),
        ));
    }
    Ok(QuickAccessItemRefRecord {
        kind: item.kind,
        id: id.to_owned(),
    })
}

pub fn normalize_quick_access_preferences(
    preferences: QuickAccessPreferencesRecord,
) -> QuickAccessPreferencesRecord {
    QuickAccessPreferencesRecord {
        pinned_items: normalize_quick_access_items(preferences.pinned_items, usize::MAX),
        recent_items: normalize_quick_access_items(
            preferences.recent_items,
            QUICK_ACCESS_RECENT_LIMIT,
        ),
    }
}

fn normalize_quick_access_items(
    items: Vec<QuickAccessItemRefRecord>,
    limit: usize,
) -> Vec<QuickAccessItemRefRecord> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter_map(|item| normalize_quick_access_item(item).ok())
        .filter(|item| seen.insert((item.kind.clone(), item.id.clone())))
        .take(limit)
        .collect()
}

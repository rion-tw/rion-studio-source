    #[test]
    fn quick_access_preferences_normalize_stable_refs_and_mru_limit() {
        let item = |kind: &str, id: &str| QuickAccessItemRefRecord {
            kind: kind.to_owned(),
            id: id.to_owned(),
        };
        let preferences = normalize_quick_access_preferences(QuickAccessPreferencesRecord {
            pinned_items: vec![
                item("role", " role-1 "),
                item("workspace", "workspace-1"),
                item("role", "role-1"),
                item("route", "dashboard"),
                item("macro", ""),
            ],
            recent_items: (0..25)
                .map(|index| item("macro", &format!("macro-{index}")))
                .chain(std::iter::once(item("macro", "macro-0")))
                .collect(),
        });

        assert_eq!(
            preferences.pinned_items,
            vec![item("role", "role-1"), item("workspace", "workspace-1")]
        );
        assert_eq!(preferences.recent_items.len(), QUICK_ACCESS_RECENT_LIMIT);
        assert_eq!(preferences.recent_items[0], item("macro", "macro-0"));
        assert_eq!(preferences.recent_items[19], item("macro", "macro-19"));
        assert!(normalize_quick_access_item(item("route", "dashboard")).is_err());
    }

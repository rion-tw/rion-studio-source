use std::collections::HashSet;

use crate::model::SystemFontFamilyRecord;

const FALLBACK_FONT_FAMILIES: &[&str] = &[
    "Arial",
    "Helvetica",
    "Times New Roman",
    "Times",
    "Georgia",
    "Verdana",
    "Courier New",
    "Menlo",
    "Monaco",
    "PingFang TC",
    "PingFang SC",
    "Microsoft JhengHei",
    "Microsoft YaHei",
    "Noto Sans",
    "Noto Serif",
    "Noto Sans Math",
];

pub fn normalize(values: Vec<String>) -> Vec<SystemFontFamilyRecord> {
    let mut seen = HashSet::new();
    let mut fonts = values
        .into_iter()
        .filter_map(|value| normalize_family(&value))
        .filter_map(|family| {
            seen.insert(family.to_lowercase())
                .then_some(SystemFontFamilyRecord {
                    label: family.clone(),
                    family,
                })
        })
        .collect::<Vec<_>>();
    fonts.sort_by_cached_key(|font| font.label.to_lowercase());
    fonts
}

pub fn normalize_or_fallback(values: Vec<String>) -> Vec<SystemFontFamilyRecord> {
    let fonts = normalize(values);
    if fonts.is_empty() {
        normalize(
            FALLBACK_FONT_FAMILIES
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        )
    } else {
        fonts
    }
}

fn normalize_family(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()
        && normalized.len() <= 120
        && !normalized
            .chars()
            .any(|character| character <= '\u{1f}' || character == '\u{7f}'))
    .then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_sorts_and_deduplicates_names() {
        assert_eq!(
            normalize(vec![
                "  Zed  Sans ".to_owned(),
                "arial".to_owned(),
                "Arial".to_owned(),
                "bad\0font".to_owned(),
            ]),
            vec![
                SystemFontFamilyRecord {
                    family: "arial".to_owned(),
                    label: "arial".to_owned(),
                },
                SystemFontFamilyRecord {
                    family: "Zed Sans".to_owned(),
                    label: "Zed Sans".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn supplies_a_bounded_cross_platform_fallback() {
        let fonts = normalize_or_fallback(Vec::new());
        assert!(fonts.iter().any(|font| font.family == "Arial"));
        assert!(fonts.iter().any(|font| font.family == "Microsoft JhengHei"));
    }
}

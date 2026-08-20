#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct QuickAccessItemRefRecord {
    #[ts(type = "\"role\" | \"workspace\" | \"gameWindow\" | \"macro\"")]
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct QuickAccessPreferencesRecord {
    #[serde(default)]
    pub pinned_items: Vec<QuickAccessItemRefRecord>,
    #[serde(default)]
    pub recent_items: Vec<QuickAccessItemRefRecord>,
}

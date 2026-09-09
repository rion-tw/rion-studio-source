#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum GpuRasterizationMode {
    #[default]
    Auto,
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub enum HardwareVideoDecodeMode {
    #[default]
    Auto,
    Disabled,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GraphicsSettingsRecord {
    pub hardware_acceleration: bool,
    pub rasterization: GpuRasterizationMode,
    pub video_decode: HardwareVideoDecodeMode,
}

impl Default for GraphicsSettingsRecord {
    fn default() -> Self {
        Self {
            hardware_acceleration: true,
            rasterization: GpuRasterizationMode::Auto,
            video_decode: HardwareVideoDecodeMode::Auto,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GraphicsSettingsSnapshotRecord {
    #[ts(type = "number")]
    pub revision: u64,
    pub settings: GraphicsSettingsRecord,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct GraphicsStatusRecord {
    pub supported: bool,
    #[ts(type = "number")]
    pub sequence: u64,
    pub initialized: bool,
    pub hardware_acceleration: Option<bool>,
    pub applied_settings: Option<GraphicsSettingsRecord>,
    pub features: BTreeMap<String, String>,
    pub devices: Vec<BTreeMap<String, String>>,
    pub driver: BTreeMap<String, String>,
    pub versions: BTreeMap<String, String>,
    pub problems: Vec<String>,
    pub complete: bool,
    pub error: Option<String>,
}

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::Engine as _;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    CoreError, CoreResult,
    model::{
        BrowserFontCatalogEntryRecord, BrowserFontInstallResultRecord,
        BrowserFontRuntimeFaceRecord, BrowserFontRuntimePayloadRecord, BrowserFontSelectionRecord,
        BrowserFontSettingsRecord,
    },
};

const CACHE_DIRECTORY: &str = "fonts/google";
const CACHE_SCHEMA_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
const MAX_CSS_BYTES: usize = 512 * 1024;
const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MAX_PACK_BYTES: usize = 64 * 1024 * 1024;
const MAX_PACK_ASSETS: usize = 256;
const GOOGLE_CSS_HOST: &str = "fonts.googleapis.com";
const GOOGLE_ASSET_HOST: &str = "fonts.gstatic.com";
const FONT_USER_AGENT: &str = "Mozilla/5.0 AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const CUSTOM_CATALOG_ID_PREFIX: &str = "custom-";
const CUSTOM_CATALOG_HASH_LENGTH: usize = 32;

#[derive(Clone, Copy)]
struct CatalogSpec {
    id: &'static str,
    family: &'static str,
    category: &'static str,
    scripts: &'static [&'static str],
    weights: &'static [u16],
    download_weights: &'static [u16],
    usage: &'static str,
}

const CATALOG: &[CatalogSpec] = &[
    cjk_spec(
        "noto-sans-tc",
        "Noto Sans TC",
        "sans",
        &["tc", "latin"],
        &[400, 700],
        "body",
    ),
    cjk_spec(
        "noto-sans-sc",
        "Noto Sans SC",
        "sans",
        &["sc", "latin"],
        &[400, 700],
        "body",
    ),
    cjk_spec(
        "noto-sans-jp",
        "Noto Sans JP",
        "sans",
        &["jp", "latin"],
        &[400, 700],
        "body",
    ),
    cjk_spec(
        "noto-serif-tc",
        "Noto Serif TC",
        "serif",
        &["tc", "latin"],
        &[400, 700],
        "body",
    ),
    cjk_spec(
        "noto-serif-sc",
        "Noto Serif SC",
        "serif",
        &["sc", "latin"],
        &[400, 700],
        "body",
    ),
    cjk_spec(
        "noto-serif-jp",
        "Noto Serif JP",
        "serif",
        &["jp", "latin"],
        &[400, 700],
        "body",
    ),
    spec("inter", "Inter", "sans", &["latin"], &[400, 700], "body"),
    spec("roboto", "Roboto", "sans", &["latin"], &[400, 700], "body"),
    spec(
        "open-sans",
        "Open Sans",
        "sans",
        &["latin"],
        &[400, 700],
        "body",
    ),
    spec("lato", "Lato", "sans", &["latin"], &[400, 700], "body"),
    spec(
        "source-sans-3",
        "Source Sans 3",
        "sans",
        &["latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "source-serif-4",
        "Source Serif 4",
        "serif",
        &["latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "roboto-mono",
        "Roboto Mono",
        "monospace",
        &["latin"],
        &[400, 700],
        "technical",
    ),
    spec(
        "jetbrains-mono",
        "JetBrains Mono",
        "monospace",
        &["latin"],
        &[400, 700],
        "technical",
    ),
    spec(
        "noto-sans-math",
        "Noto Sans Math",
        "math",
        &["math", "latin"],
        &[400],
        "technical",
    ),
    spec(
        "iansui",
        "Iansui",
        "handwriting",
        &["tc", "latin"],
        &[400],
        "body",
    ),
    cjk_spec(
        "lxgw-wenkai-tc",
        "LXGW WenKai TC",
        "handwriting",
        &["tc", "latin"],
        &[300, 400, 700],
        "body",
    ),
    spec(
        "ma-shan-zheng",
        "Ma Shan Zheng",
        "handwriting",
        &["sc", "latin"],
        &[400],
        "accent",
    ),
    spec(
        "zhi-mang-xing",
        "Zhi Mang Xing",
        "handwriting",
        &["sc", "latin"],
        &[400],
        "accent",
    ),
    spec(
        "long-cang",
        "Long Cang",
        "handwriting",
        &["sc", "latin"],
        &[400],
        "accent",
    ),
    cjk_spec(
        "klee-one",
        "Klee One",
        "handwriting",
        &["jp", "latin"],
        &[400, 600],
        "body",
    ),
    spec(
        "yomogi",
        "Yomogi",
        "handwriting",
        &["jp", "latin"],
        &[400],
        "accent",
    ),
    spec(
        "caveat",
        "Caveat",
        "handwriting",
        &["latin"],
        &[400, 700],
        "accent",
    ),
    spec(
        "patrick-hand",
        "Patrick Hand",
        "handwriting",
        &["latin"],
        &[400],
        "body",
    ),
    spec(
        "kalam",
        "Kalam",
        "handwriting",
        &["latin"],
        &[300, 400, 700],
        "body",
    ),
    spec(
        "handlee",
        "Handlee",
        "handwriting",
        &["latin"],
        &[400],
        "body",
    ),
    spec(
        "short-stack",
        "Short Stack",
        "handwriting",
        &["latin"],
        &[400],
        "body",
    ),
    cjk_spec(
        "chiron-go-round-tc",
        "Chiron GoRound TC",
        "sans",
        &["tc", "latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "zcool-kuaile",
        "ZCOOL KuaiLe",
        "display",
        &["sc", "latin"],
        &[400],
        "accent",
    ),
    cjk_spec(
        "zen-maru-gothic",
        "Zen Maru Gothic",
        "display",
        &["jp", "latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "lxgw-marker-gothic",
        "LXGW Marker Gothic",
        "handwriting",
        &["tc", "latin"],
        &[400],
        "body",
    ),
    spec(
        "zcool-qingke-huangyou",
        "ZCOOL QingKe HuangYou",
        "display",
        &["sc", "latin"],
        &[400],
        "accent",
    ),
    spec(
        "yusei-magic",
        "Yusei Magic",
        "handwriting",
        &["jp", "latin"],
        &[400],
        "body",
    ),
    spec(
        "cactus-classical-serif",
        "Cactus Classical Serif",
        "serif",
        &["tc", "latin"],
        &[400],
        "body",
    ),
    spec(
        "zcool-xiaowei",
        "ZCOOL XiaoWei",
        "serif",
        &["sc", "latin"],
        &[400],
        "body",
    ),
    spec(
        "hina-mincho",
        "Hina Mincho",
        "serif",
        &["jp", "latin"],
        &[400],
        "body",
    ),
    spec(
        "wdxl-lubrifont-tc",
        "WDXL Lubrifont TC",
        "display",
        &["tc", "latin"],
        &[400],
        "body",
    ),
    spec(
        "wdxl-lubrifont-sc",
        "WDXL Lubrifont SC",
        "display",
        &["sc", "latin"],
        &[400],
        "body",
    ),
    spec(
        "wdxl-lubrifont-jp-n",
        "WDXL Lubrifont JP N",
        "display",
        &["jp", "latin"],
        &[400],
        "body",
    ),
    spec(
        "fredoka",
        "Fredoka",
        "display",
        &["latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "permanent-marker",
        "Permanent Marker",
        "handwriting",
        &["latin"],
        &[400],
        "accent",
    ),
    spec(
        "playfair-display",
        "Playfair Display",
        "serif",
        &["latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "pixelify-sans",
        "Pixelify Sans",
        "display",
        &["latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "press-start-2p",
        "Press Start 2P",
        "display",
        &["latin"],
        &[400],
        "accent",
    ),
    spec(
        "atkinson-hyperlegible-next",
        "Atkinson Hyperlegible Next",
        "sans",
        &["latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "atkinson-hyperlegible-mono",
        "Atkinson Hyperlegible Mono",
        "monospace",
        &["latin"],
        &[400, 700],
        "technical",
    ),
    spec(
        "roboto-condensed",
        "Roboto Condensed",
        "sans",
        &["latin"],
        &[400, 700],
        "body",
    ),
    spec(
        "cinzel",
        "Cinzel",
        "serif",
        &["latin"],
        &[400, 700],
        "accent",
    ),
    cjk_spec(
        "kaisei-tokumin",
        "Kaisei Tokumin",
        "serif",
        &["jp", "latin"],
        &[400, 700],
        "body",
    ),
    cjk_spec(
        "chocolate-classical-sans",
        "Chocolate Classical Sans",
        "sans",
        &["tc", "latin"],
        &[400],
        "body",
    ),
    cjk_spec(
        "zen-kaku-gothic-new",
        "Zen Kaku Gothic New",
        "sans",
        &["jp", "latin"],
        &[400, 700],
        "body",
    ),
    spec("exo-2", "Exo 2", "sans", &["latin"], &[400, 700], "body"),
    spec(
        "orbitron",
        "Orbitron",
        "display",
        &["latin"],
        &[400, 700],
        "accent",
    ),
    cjk_spec("huninn", "Huninn", "sans", &["tc", "latin"], &[400], "body"),
    cjk_spec(
        "kiwi-maru",
        "Kiwi Maru",
        "serif",
        &["jp", "latin"],
        &[400, 500],
        "body",
    ),
    spec("nunito", "Nunito", "sans", &["latin"], &[400, 700], "body"),
];

const fn spec(
    id: &'static str,
    family: &'static str,
    category: &'static str,
    scripts: &'static [&'static str],
    weights: &'static [u16],
    usage: &'static str,
) -> CatalogSpec {
    CatalogSpec {
        id,
        family,
        category,
        scripts,
        weights,
        download_weights: weights,
        usage,
    }
}

const fn cjk_spec(
    id: &'static str,
    family: &'static str,
    category: &'static str,
    scripts: &'static [&'static str],
    weights: &'static [u16],
    usage: &'static str,
) -> CatalogSpec {
    CatalogSpec {
        id,
        family,
        category,
        scripts,
        weights,
        download_weights: &[400],
        usage,
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedManifest {
    version: u32,
    catalog_id: String,
    family: String,
    css_url: String,
    assets: Vec<CachedAsset>,
    cached_bytes: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedAsset {
    file: String,
    sha256: String,
    style: String,
    weight: String,
    unicode_range: String,
}

struct ParsedFace {
    url: String,
    style: String,
    weight: String,
    unicode_range: String,
}

pub fn list(user_data_dir: &Path) -> Vec<BrowserFontCatalogEntryRecord> {
    let mut entries = CATALOG
        .iter()
        .map(|spec| {
            let cached_bytes = read_manifest(user_data_dir, spec.id)
                .map(|manifest| manifest.cached_bytes)
                .unwrap_or(0);
            BrowserFontCatalogEntryRecord {
                catalog_id: spec.id.to_owned(),
                family: spec.family.to_owned(),
                category: spec.category.to_owned(),
                scripts: spec
                    .scripts
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
                weights: spec.weights.to_vec(),
                usage: spec.usage.to_owned(),
                installed: cached_bytes > 0,
                cached_bytes,
            }
        })
        .collect::<Vec<_>>();
    let mut custom_entries = fs::read_dir(cache_root(user_data_dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let catalog_id = entry.file_name().to_str()?.to_owned();
            if !entry.file_type().ok()?.is_dir() || !is_custom_catalog_id(&catalog_id) {
                return None;
            }
            let manifest = read_manifest(user_data_dir, &catalog_id)?;
            read_validated_cached_assets(user_data_dir, &catalog_id, &manifest).ok()?;
            Some(BrowserFontCatalogEntryRecord {
                catalog_id,
                family: manifest.family,
                category: "sans".to_owned(),
                scripts: ["latin", "tc", "sc", "jp", "math"]
                    .map(str::to_owned)
                    .to_vec(),
                weights: vec![400],
                usage: "body".to_owned(),
                installed: true,
                cached_bytes: manifest.cached_bytes,
            })
        })
        .collect::<Vec<_>>();
    custom_entries.sort_by(|left, right| left.family.cmp(&right.family));
    entries.extend(custom_entries);
    entries
}

pub fn install(
    user_data_dir: &Path,
    catalog_id: &str,
) -> CoreResult<BrowserFontInstallResultRecord> {
    let spec = catalog_spec(catalog_id)?;
    install_pack(user_data_dir, spec.id, spec.family, spec.download_weights)
}

pub fn install_family(
    user_data_dir: &Path,
    family: &str,
) -> CoreResult<BrowserFontInstallResultRecord> {
    let family = normalize_google_font_family(family)
        .ok_or_else(|| CoreError::InvalidInput("Google Font family is invalid".to_owned()))?;
    if let Some(spec) = CATALOG
        .iter()
        .find(|spec| spec.family.eq_ignore_ascii_case(&family))
    {
        return install(user_data_dir, spec.id);
    }
    let catalog_id = custom_catalog_id_from_normalized_family(&family);
    install_pack(user_data_dir, &catalog_id, &family, &[400])
}

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
    CATALOG
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
        .collect()
}

pub fn install(
    user_data_dir: &Path,
    catalog_id: &str,
) -> CoreResult<BrowserFontInstallResultRecord> {
    let spec = catalog_spec(catalog_id)?;
    let final_path = pack_path(user_data_dir, spec.id);
    if let Some(manifest) = read_manifest(user_data_dir, spec.id) {
        if read_validated_cached_assets(user_data_dir, spec.id, &manifest).is_ok() {
            return Ok(install_result(spec.id, manifest.cached_bytes));
        }
        remove_cache_path(&final_path)?;
    } else if fs::symlink_metadata(&final_path).is_ok() {
        remove_cache_path(&final_path)?;
    }
    let cache_root = user_data_dir.join(CACHE_DIRECTORY);
    fs::create_dir_all(&cache_root).map_err(font_io)?;
    rion_platform::restrict_directory_to_current_user(&cache_root)
        .map_err(|error| CoreError::Platform(error.to_string()))?;
    let staging = tempfile::Builder::new()
        .prefix(".font-pack-")
        .tempdir_in(&cache_root)
        .map_err(font_io)?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(FONT_USER_AGENT)
        .build()
        .map_err(|error| font_download(error.to_string()))?;
    let css_url = css_url(spec);
    validate_download_url(&css_url, GOOGLE_CSS_HOST)?;
    let css = download(&client, &css_url, MAX_CSS_BYTES)?;
    let css = String::from_utf8(css)
        .map_err(|error| font_download(format!("Google Fonts CSS is not UTF-8: {error}")))?;
    let faces = parse_faces(&css)?;
    if faces.is_empty() || faces.len() > MAX_PACK_ASSETS {
        return Err(font_download(
            "Google Fonts returned an invalid number of assets.",
        ));
    }

    let mut downloaded = HashMap::<String, (String, String, usize)>::new();
    let mut assets = Vec::with_capacity(faces.len());
    let mut total_bytes = 0_usize;
    for face in faces {
        validate_download_url(&face.url, GOOGLE_ASSET_HOST)?;
        let (file, sha256, bytes) = if let Some(existing) = downloaded.get(&face.url) {
            existing.clone()
        } else {
            let bytes = download(&client, &face.url, MAX_ASSET_BYTES)?;
            if !bytes.starts_with(b"wOF2") {
                return Err(font_download("Google Fonts returned a non-WOFF2 asset."));
            }
            total_bytes = total_bytes.saturating_add(bytes.len());
            if total_bytes > MAX_PACK_BYTES {
                return Err(font_download(
                    "The selected font pack exceeds the size limit.",
                ));
            }
            let sha256 = format!("{:x}", Sha256::digest(&bytes));
            let file = format!("{sha256}.woff2");
            let path = staging.path().join(&file);
            let mut output = fs::File::create(&path).map_err(font_io)?;
            output.write_all(&bytes).map_err(font_io)?;
            output.sync_all().map_err(font_io)?;
            let value = (file, sha256, bytes.len());
            downloaded.insert(face.url.clone(), value.clone());
            value
        };
        assets.push(CachedAsset {
            file,
            sha256,
            style: face.style,
            weight: face.weight,
            unicode_range: face.unicode_range,
        });
        let _ = bytes;
    }
    let manifest = CachedManifest {
        version: CACHE_SCHEMA_VERSION,
        catalog_id: spec.id.to_owned(),
        family: spec.family.to_owned(),
        css_url,
        assets,
        cached_bytes: total_bytes as u64,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| CoreError::Internal(error.to_string()))?;
    let mut manifest_file =
        fs::File::create(staging.path().join(MANIFEST_FILE)).map_err(font_io)?;
    manifest_file.write_all(&manifest_bytes).map_err(font_io)?;
    manifest_file.sync_all().map_err(font_io)?;
    drop(manifest_file);
    if let Err(error) = fs::rename(staging.path(), &final_path) {
        if let Some(installed_manifest) = read_manifest(user_data_dir, spec.id)
            && read_validated_cached_assets(user_data_dir, spec.id, &installed_manifest).is_ok()
        {
            return Ok(install_result(spec.id, installed_manifest.cached_bytes));
        }
        return Err(font_io(error));
    }
    Ok(install_result(spec.id, manifest.cached_bytes))
}

pub fn remove(
    user_data_dir: &Path,
    catalog_id: &str,
) -> CoreResult<BrowserFontInstallResultRecord> {
    let spec = catalog_spec(catalog_id)?;
    let path = pack_path(user_data_dir, spec.id);
    if fs::symlink_metadata(&path).is_ok() {
        remove_cache_path(&path)?;
    }
    Ok(BrowserFontInstallResultRecord {
        catalog_id: spec.id.to_owned(),
        installed: false,
        cached_bytes: 0,
    })
}

pub fn runtime_payload(
    user_data_dir: &Path,
    settings: BrowserFontSettingsRecord,
) -> CoreResult<BrowserFontRuntimePayloadRecord> {
    let catalog_ids = settings
        .slots
        .values()
        .filter_map(|selection| match selection {
            BrowserFontSelectionRecord::Google { catalog_id } => Some(catalog_id.as_str()),
            BrowserFontSelectionRecord::System { .. } => None,
        })
        .collect::<HashSet<_>>();
    let mut faces = Vec::new();
    for catalog_id in catalog_ids {
        let Ok(spec) = catalog_spec(catalog_id) else {
            continue;
        };
        let Some(manifest) = read_manifest(user_data_dir, spec.id) else {
            continue;
        };
        let validated_assets = read_validated_cached_assets(user_data_dir, spec.id, &manifest)?;
        for asset in manifest.assets {
            let bytes = validated_assets
                .get(&asset.file)
                .ok_or_else(|| font_cache_invalid(spec.id))?;
            faces.push(BrowserFontRuntimeFaceRecord {
                catalog_id: spec.id.to_owned(),
                family: spec.family.to_owned(),
                style: asset.style,
                weight: asset.weight,
                unicode_range: asset.unicode_range,
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
    }
    Ok(BrowserFontRuntimePayloadRecord { settings, faces })
}

fn css_url(spec: &CatalogSpec) -> String {
    let family = spec.family.replace(' ', "+");
    let weights = spec
        .download_weights
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(";");
    if spec.download_weights == [400] {
        format!("https://{GOOGLE_CSS_HOST}/css2?family={family}&display=swap")
    } else {
        format!("https://{GOOGLE_CSS_HOST}/css2?family={family}:wght@{weights}&display=swap")
    }
}

fn parse_faces(css: &str) -> CoreResult<Vec<ParsedFace>> {
    let block = Regex::new(r"(?s)@font-face\s*\{(.*?)\}")
        .map_err(|error| CoreError::Internal(error.to_string()))?;
    let url = Regex::new(r#"url\(['\"]?(https://[^)'\"]+)['\"]?\)"#)
        .map_err(|error| CoreError::Internal(error.to_string()))?;
    let mut faces = Vec::new();
    for capture in block.captures_iter(css) {
        let body = capture
            .get(1)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let Some(asset_url) = url
            .captures(body)
            .and_then(|capture| capture.get(1))
            .map(|value| value.as_str().to_owned())
        else {
            continue;
        };
        let properties = body
            .split(';')
            .filter_map(|declaration| declaration.split_once(':'))
            .map(|(key, value)| (key.trim(), value.trim()))
            .collect::<HashMap<_, _>>();
        faces.push(ParsedFace {
            url: asset_url,
            style: properties
                .get("font-style")
                .copied()
                .unwrap_or("normal")
                .to_owned(),
            weight: properties
                .get("font-weight")
                .copied()
                .unwrap_or("400")
                .to_owned(),
            unicode_range: properties
                .get("unicode-range")
                .copied()
                .unwrap_or("")
                .to_owned(),
        });
    }
    Ok(faces)
}

fn download(client: &reqwest::blocking::Client, url: &str, maximum: usize) -> CoreResult<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .map_err(|error| font_download(error.to_string()))?;
    if !response.status().is_success() {
        return Err(font_download(format!(
            "Font download returned HTTP {}.",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(font_download("Font download exceeded the size limit."));
    }
    let mut bytes =
        Vec::with_capacity(response.content_length().unwrap_or(0).min(maximum as u64) as usize);
    response
        .take(maximum.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| font_download(error.to_string()))?;
    if bytes.len() > maximum {
        return Err(font_download("Font download exceeded the size limit."));
    }
    Ok(bytes)
}

fn validate_download_url(value: &str, host: &str) -> CoreResult<()> {
    let url = url::Url::parse(value).map_err(|error| font_download(error.to_string()))?;
    if url.scheme() != "https"
        || url.host_str() != Some(host)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(font_download("Font download URL is not allowlisted."));
    }
    Ok(())
}

fn catalog_spec(catalog_id: &str) -> CoreResult<&'static CatalogSpec> {
    CATALOG
        .iter()
        .find(|spec| spec.id == catalog_id)
        .ok_or(CoreError::Domain {
            code: "BROWSER_FONT_NOT_FOUND",
            message: "The selected font is not in the curated catalog.".to_owned(),
        })
}

pub(crate) fn contains(catalog_id: &str) -> bool {
    CATALOG.iter().any(|spec| spec.id == catalog_id)
}

fn cache_root(user_data_dir: &Path) -> PathBuf {
    user_data_dir.join(CACHE_DIRECTORY)
}

fn pack_path(user_data_dir: &Path, catalog_id: &str) -> PathBuf {
    cache_root(user_data_dir).join(catalog_id)
}

fn remove_cache_path(path: &Path) -> CoreResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(font_io)?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(font_io)
    } else {
        fs::remove_dir_all(path).map_err(font_io)
    }
}

fn read_manifest(user_data_dir: &Path, catalog_id: &str) -> Option<CachedManifest> {
    let path = pack_path(user_data_dir, catalog_id).join(MANIFEST_FILE);
    let manifest = serde_json::from_slice::<CachedManifest>(&fs::read(path).ok()?).ok()?;
    (manifest.version == CACHE_SCHEMA_VERSION
        && manifest.catalog_id == catalog_id
        && !manifest.family.trim().is_empty()
        && !manifest.assets.is_empty()
        && manifest.assets.len() <= MAX_PACK_ASSETS
        && manifest.cached_bytes <= MAX_PACK_BYTES as u64
        && manifest.assets.iter().all(|asset| {
            asset.sha256.len() == 64
                && asset.sha256.chars().all(|character| {
                    character.is_ascii_hexdigit() && !character.is_ascii_uppercase()
                })
                && asset.file == format!("{}.woff2", asset.sha256)
                && asset.style.len() <= 32
                && asset.weight.len() <= 32
                && asset.unicode_range.len() <= 8 * 1024
        }))
    .then_some(manifest)
}

fn read_validated_cached_assets(
    user_data_dir: &Path,
    catalog_id: &str,
    manifest: &CachedManifest,
) -> CoreResult<HashMap<String, Vec<u8>>> {
    let directory = pack_path(user_data_dir, catalog_id);
    let mut validated_files = HashMap::new();
    let mut total_bytes = 0_u64;
    for asset in &manifest.assets {
        if validated_files.contains_key(&asset.file) {
            continue;
        }
        let bytes = fs::read(directory.join(&asset.file)).map_err(font_io)?;
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if total_bytes > MAX_PACK_BYTES as u64
            || !bytes.starts_with(b"wOF2")
            || format!("{:x}", Sha256::digest(&bytes)) != asset.sha256
        {
            return Err(font_cache_invalid(catalog_id));
        }
        validated_files.insert(asset.file.clone(), bytes);
    }
    if total_bytes != manifest.cached_bytes {
        return Err(font_cache_invalid(catalog_id));
    }
    Ok(validated_files)
}

fn install_result(catalog_id: &str, cached_bytes: u64) -> BrowserFontInstallResultRecord {
    BrowserFontInstallResultRecord {
        catalog_id: catalog_id.to_owned(),
        installed: true,
        cached_bytes,
    }
}

fn font_io(error: std::io::Error) -> CoreError {
    CoreError::Domain {
        code: "BROWSER_FONT_CACHE_FAILED",
        message: format!("Unable to update the browser font cache: {error}"),
    }
}

fn font_download(message: impl Into<String>) -> CoreError {
    CoreError::Domain {
        code: "BROWSER_FONT_DOWNLOAD_FAILED",
        message: message.into(),
    }
}

fn font_cache_invalid(catalog_id: &str) -> CoreError {
    CoreError::Domain {
        code: "BROWSER_FONT_CACHE_INVALID",
        message: format!("The cached font pack {catalog_id} failed integrity validation."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn catalog_ids_and_download_hosts_are_bounded() {
        let mut ids = HashSet::new();
        for spec in CATALOG {
            assert!(ids.insert(spec.id));
            assert!(
                spec.id
                    .chars()
                    .all(|character| character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || character == '-')
            );
            validate_download_url(&css_url(spec), GOOGLE_CSS_HOST).unwrap();
        }
    }

    #[test]
    fn parses_google_font_face_descriptors() {
        let faces = parse_faces(
            "@font-face { font-family: 'Demo'; font-style: normal; font-weight: 400 700; src: url(https://fonts.gstatic.com/s/demo/v1/demo.woff2) format('woff2'); unicode-range: U+0000-00FF; }",
        )
        .unwrap();
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].weight, "400 700");
        assert_eq!(faces[0].unicode_range, "U+0000-00FF");
    }

    #[test]
    fn large_cjk_catalog_entries_download_one_regular_weight() {
        for spec in CATALOG.iter().filter(|spec| {
            spec.weights.len() > 1
                && spec
                    .scripts
                    .iter()
                    .any(|script| matches!(*script, "tc" | "sc" | "jp"))
        }) {
            assert_eq!(
                spec.download_weights,
                [400],
                "unexpected CJK request for {}",
                spec.id
            );
            assert!(!css_url(spec).contains(";"));
        }
    }

    #[test]
    fn cached_assets_are_bounded_and_integrity_checked() {
        let directory = tempdir().unwrap();
        let pack = pack_path(directory.path(), "inter");
        fs::create_dir_all(&pack).unwrap();
        let bytes = b"wOF2verified-test-font";
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let file = format!("{sha256}.woff2");
        fs::write(pack.join(&file), bytes).unwrap();
        let manifest = CachedManifest {
            version: CACHE_SCHEMA_VERSION,
            catalog_id: "inter".to_owned(),
            family: "Inter".to_owned(),
            css_url: "https://fonts.googleapis.com/css2?family=Inter".to_owned(),
            assets: vec![CachedAsset {
                file: file.clone(),
                sha256,
                style: "normal".to_owned(),
                weight: "400".to_owned(),
                unicode_range: "U+0000-00FF".to_owned(),
            }],
            cached_bytes: bytes.len() as u64,
        };
        fs::write(
            pack.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let loaded = read_manifest(directory.path(), "inter").unwrap();
        assert!(read_validated_cached_assets(directory.path(), "inter", &loaded).is_ok());
        fs::write(pack.join(&file), b"wOF2tampered").unwrap();
        assert!(read_validated_cached_assets(directory.path(), "inter", &loaded).is_err());

        let mut escaping = manifest;
        escaping.assets[0].file = "../outside.woff2".to_owned();
        fs::write(
            pack.join(MANIFEST_FILE),
            serde_json::to_vec(&escaping).unwrap(),
        )
        .unwrap();
        assert!(read_manifest(directory.path(), "inter").is_none());
    }
}

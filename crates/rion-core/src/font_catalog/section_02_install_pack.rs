fn install_pack(
    user_data_dir: &Path,
    catalog_id: &str,
    family: &str,
    download_weights: &[u16],
) -> CoreResult<BrowserFontInstallResultRecord> {
    let final_path = pack_path(user_data_dir, catalog_id);
    if let Some(manifest) = read_manifest(user_data_dir, catalog_id) {
        if read_validated_cached_assets(user_data_dir, catalog_id, &manifest).is_ok() {
            return Ok(install_result(catalog_id, manifest.cached_bytes));
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
    let css_url = css_url_for_family(family, download_weights);
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
        catalog_id: catalog_id.to_owned(),
        family: family.to_owned(),
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
        if let Some(installed_manifest) = read_manifest(user_data_dir, catalog_id)
            && read_validated_cached_assets(user_data_dir, catalog_id, &installed_manifest).is_ok()
        {
            return Ok(install_result(catalog_id, installed_manifest.cached_bytes));
        }
        return Err(font_io(error));
    }
    Ok(install_result(catalog_id, manifest.cached_bytes))
}

pub fn remove(
    user_data_dir: &Path,
    catalog_id: &str,
) -> CoreResult<BrowserFontInstallResultRecord> {
    if !contains(catalog_id) {
        return Err(font_not_found());
    }
    let path = pack_path(user_data_dir, catalog_id);
    if fs::symlink_metadata(&path).is_ok() {
        remove_cache_path(&path)?;
    }
    Ok(BrowserFontInstallResultRecord {
        catalog_id: catalog_id.to_owned(),
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
            BrowserFontSelectionRecord::Google { catalog_id, .. } => Some(catalog_id.as_str()),
            BrowserFontSelectionRecord::System { .. } => None,
        })
        .collect::<HashSet<_>>();
    let mut faces = Vec::new();
    for catalog_id in catalog_ids {
        if !contains(catalog_id) {
            continue;
        }
        let Some(manifest) = read_manifest(user_data_dir, catalog_id) else {
            continue;
        };
        let validated_assets = read_validated_cached_assets(user_data_dir, catalog_id, &manifest)?;
        for asset in manifest.assets {
            let bytes = validated_assets
                .get(&asset.file)
                .ok_or_else(|| font_cache_invalid(catalog_id))?;
            faces.push(BrowserFontRuntimeFaceRecord {
                catalog_id: catalog_id.to_owned(),
                family: manifest.family.clone(),
                style: asset.style,
                weight: asset.weight,
                unicode_range: asset.unicode_range,
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
    }
    Ok(BrowserFontRuntimePayloadRecord { settings, faces })
}

fn css_url_for_family(family: &str, download_weights: &[u16]) -> String {
    let weights = download_weights
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(";");
    let family = if download_weights == [400] {
        family.to_owned()
    } else {
        format!("{family}:wght@{weights}")
    };
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer
        .append_pair("family", &family)
        .append_pair("display", "swap");
    let query = serializer.finish();
    format!("https://{GOOGLE_CSS_HOST}/css2?{query}")
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
        .ok_or_else(font_not_found)
}

pub(crate) fn contains(catalog_id: &str) -> bool {
    CATALOG.iter().any(|spec| spec.id == catalog_id) || is_custom_catalog_id(catalog_id)
}

pub(crate) fn custom_catalog_id(family: &str) -> Option<String> {
    normalize_google_font_family(family)
        .map(|family| custom_catalog_id_from_normalized_family(&family))
}

fn custom_catalog_id_from_normalized_family(family: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(family.to_lowercase().as_bytes()));
    format!(
        "{CUSTOM_CATALOG_ID_PREFIX}{}",
        &digest[..CUSTOM_CATALOG_HASH_LENGTH]
    )
}

pub(crate) fn is_custom_catalog_id(catalog_id: &str) -> bool {
    catalog_id.len() == CUSTOM_CATALOG_ID_PREFIX.len() + CUSTOM_CATALOG_HASH_LENGTH
        && catalog_id.starts_with(CUSTOM_CATALOG_ID_PREFIX)
        && catalog_id[CUSTOM_CATALOG_ID_PREFIX.len()..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

fn normalize_google_font_family(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty() && normalized.len() <= 120 && !normalized.chars().any(char::is_control))
        .then_some(normalized)
}

fn font_not_found() -> CoreError {
    CoreError::Domain {
        code: "BROWSER_FONT_NOT_FOUND",
        message: "The selected font is not in the browser font catalog.".to_owned(),
    }
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
        && manifest_identity_is_valid(catalog_id, &manifest.family)
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

fn manifest_identity_is_valid(catalog_id: &str, family: &str) -> bool {
    if let Some(spec) = CATALOG.iter().find(|spec| spec.id == catalog_id) {
        return family == spec.family;
    }
    custom_catalog_id(family).as_deref() == Some(catalog_id)
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

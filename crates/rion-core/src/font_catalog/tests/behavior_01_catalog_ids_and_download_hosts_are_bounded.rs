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
            validate_download_url(
                &css_url_for_family(spec.family, spec.download_weights),
                GOOGLE_CSS_HOST,
            )
            .unwrap();
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
            let url =
                url::Url::parse(&css_url_for_family(spec.family, spec.download_weights)).unwrap();
            assert_eq!(
                url.query_pairs()
                    .find(|(key, _)| key == "family")
                    .map(|(_, value)| value.into_owned()),
                Some(spec.family.to_owned())
            );
        }
    }

    #[test]
    fn personality_catalog_entries_expose_curated_metadata() {
        let directory = tempdir().unwrap();
        let entries = list(directory.path());
        let expected = [
            ("chiron-go-round-tc", "sans", "tc,latin", "400,700", "body"),
            ("zcool-kuaile", "display", "sc,latin", "400", "accent"),
            ("zen-maru-gothic", "display", "jp,latin", "400,700", "body"),
            (
                "lxgw-marker-gothic",
                "handwriting",
                "tc,latin",
                "400",
                "body",
            ),
            (
                "zcool-qingke-huangyou",
                "display",
                "sc,latin",
                "400",
                "accent",
            ),
            ("yusei-magic", "handwriting", "jp,latin", "400", "body"),
            ("cactus-classical-serif", "serif", "tc,latin", "400", "body"),
            ("zcool-xiaowei", "serif", "sc,latin", "400", "body"),
            ("hina-mincho", "serif", "jp,latin", "400", "body"),
            ("wdxl-lubrifont-tc", "display", "tc,latin", "400", "body"),
            ("wdxl-lubrifont-sc", "display", "sc,latin", "400", "body"),
            ("wdxl-lubrifont-jp-n", "display", "jp,latin", "400", "body"),
            ("fredoka", "display", "latin", "400,700", "body"),
            ("permanent-marker", "handwriting", "latin", "400", "accent"),
            ("playfair-display", "serif", "latin", "400,700", "body"),
            ("pixelify-sans", "display", "latin", "400,700", "body"),
            ("press-start-2p", "display", "latin", "400", "accent"),
        ];

        for (catalog_id, category, scripts, weights, usage) in expected {
            let entry = entries
                .iter()
                .find(|entry| entry.catalog_id == catalog_id)
                .unwrap_or_else(|| panic!("missing personality font {catalog_id}"));
            assert_eq!(entry.category, category);
            assert_eq!(entry.scripts.join(","), scripts);
            assert_eq!(
                entry
                    .weights
                    .iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
                weights
            );
            assert_eq!(entry.usage, usage);
        }
    }

    #[test]
    fn new_preset_catalog_entries_expose_curated_metadata() {
        let directory = tempdir().unwrap();
        let entries = list(directory.path());
        let expected = [
            ("handlee", "handwriting", "latin", "400", "400", "body"),
            ("short-stack", "handwriting", "latin", "400", "400", "body"),
            (
                "atkinson-hyperlegible-next",
                "sans",
                "latin",
                "400,700",
                "400,700",
                "body",
            ),
            (
                "atkinson-hyperlegible-mono",
                "monospace",
                "latin",
                "400,700",
                "400,700",
                "technical",
            ),
            (
                "roboto-condensed",
                "sans",
                "latin",
                "400,700",
                "400,700",
                "body",
            ),
            ("cinzel", "serif", "latin", "400,700", "400,700", "accent"),
            (
                "kaisei-tokumin",
                "serif",
                "jp,latin",
                "400,700",
                "400",
                "body",
            ),
            (
                "chocolate-classical-sans",
                "sans",
                "tc,latin",
                "400",
                "400",
                "body",
            ),
            (
                "zen-kaku-gothic-new",
                "sans",
                "jp,latin",
                "400,700",
                "400",
                "body",
            ),
            ("exo-2", "sans", "latin", "400,700", "400,700", "body"),
            (
                "orbitron", "display", "latin", "400,700", "400,700", "accent",
            ),
            ("huninn", "sans", "tc,latin", "400", "400", "body"),
            ("kiwi-maru", "serif", "jp,latin", "400,500", "400", "body"),
            ("nunito", "sans", "latin", "400,700", "400,700", "body"),
        ];

        for (catalog_id, category, scripts, weights, download_weights, usage) in expected {
            let entry = entries
                .iter()
                .find(|entry| entry.catalog_id == catalog_id)
                .unwrap_or_else(|| panic!("missing new preset font {catalog_id}"));
            let spec = CATALOG
                .iter()
                .find(|spec| spec.id == catalog_id)
                .unwrap_or_else(|| panic!("missing new preset spec {catalog_id}"));
            assert_eq!(entry.category, category);
            assert_eq!(entry.scripts.join(","), scripts);
            assert_eq!(
                entry
                    .weights
                    .iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
                weights
            );
            assert_eq!(
                spec.download_weights
                    .iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
                download_weights
            );
            assert_eq!(entry.usage, usage);
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

    #[test]
    fn custom_font_ids_are_stable_and_css_queries_are_encoded() {
        let id = custom_catalog_id("  Cormorant   Garamond  ").unwrap();
        assert_eq!(id, custom_catalog_id("cormorant garamond").unwrap());
        assert!(is_custom_catalog_id(&id));
        assert!(!is_custom_catalog_id("custom-cormorant-garamond"));
        assert!(custom_catalog_id("\0invalid").is_none());

        let url = url::Url::parse(&css_url_for_family("A&B Display", &[400])).unwrap();
        let query = url.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            query.get("family").map(|value| value.as_ref()),
            Some("A&B Display")
        );
        assert_eq!(
            query.get("display").map(|value| value.as_ref()),
            Some("swap")
        );
    }

    #[test]
    fn custom_font_cache_is_listed_and_loaded_into_runtime_payloads() {
        let directory = tempdir().unwrap();
        let family = "Cormorant Garamond";
        let catalog_id = custom_catalog_id(family).unwrap();
        let pack = pack_path(directory.path(), &catalog_id);
        fs::create_dir_all(&pack).unwrap();
        let bytes = b"wOF2verified-custom-font";
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let file = format!("{sha256}.woff2");
        fs::write(pack.join(&file), bytes).unwrap();
        let manifest = CachedManifest {
            version: CACHE_SCHEMA_VERSION,
            catalog_id: catalog_id.clone(),
            family: family.to_owned(),
            css_url: css_url_for_family(family, &[400]),
            assets: vec![CachedAsset {
                file,
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

        let entry = list(directory.path())
            .into_iter()
            .find(|entry| entry.catalog_id == catalog_id)
            .expect("custom font should be listed");
        assert_eq!(entry.family, family);
        assert!(entry.installed);

        let settings = BrowserFontSettingsRecord {
            mode: "custom".to_owned(),
            font_smoothing_enabled: true,
            preset_id: None,
            cjk_variant: "auto".to_owned(),
            slots: HashMap::from([(
                "latin".to_owned(),
                BrowserFontSelectionRecord::Google {
                    catalog_id: catalog_id.clone(),
                    family: Some(family.to_owned()),
                },
            )]),
        };
        let payload = runtime_payload(directory.path(), settings).unwrap();
        assert_eq!(payload.faces.len(), 1);
        assert_eq!(payload.faces[0].catalog_id, catalog_id);
        assert_eq!(payload.faces[0].family, family);
    }

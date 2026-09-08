use super::*;

const LATEST: &str = "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
const TAGGED: &str = "https://github.com/rion-tw/rion-studio/releases/download/v8.4.2/latest.json";
const CDN: &str = "https://release-assets.githubusercontent.com/github-production-release-asset/1298345475/c9c92616-728b-4ebf-8909-7e8e41fa9739?signature=opaque";

fn allows(previous: &[&str], next: &str) -> bool {
    permits_redirect(
        &previous
            .iter()
            .map(|url| Url::parse(url).unwrap())
            .collect::<Vec<_>>(),
        &Url::parse(next).unwrap(),
    )
}

#[test]
fn preserves_the_observed_two_hop_manifest_route_and_tagged_payload_route() {
    assert!(allows(&[LATEST], TAGGED));
    assert!(allows(&[LATEST, TAGGED], CDN));
    for artifact in ["Rion.Studio-mac.app.tar.gz", "Rion.Studio-win.exe"] {
        let tagged = TAGGED.replace("latest.json", artifact);
        assert!(allows(&[&tagged], CDN), "{artifact}");
    }
}

#[test]
fn rejects_foreign_initial_origins_repositories_and_non_release_paths() {
    for source in [
        LATEST.replace("github.com", "updates.example.test"),
        LATEST.replace("github.com", "github.com.evil.test"),
        LATEST.replace("rion-tw/rion-studio", "foreign/repository"),
        LATEST.replace("releases/latest/download", "raw/main"),
        LATEST.replace("latest.json", "foreign.exe"),
        format!("{LATEST}?redirect=1"),
    ] {
        assert!(!allows(&[&source], CDN), "{source}");
    }
}

#[test]
fn rejects_asset_substitution_unsafe_targets_and_foreign_cdn_repositories() {
    for next in [
        TAGGED.replace("latest.json", "Rion.Studio-win.exe"),
        TAGGED.replace("v8.4.2", "main"),
        CDN.replace("https://", "http://"),
        CDN.replace("https://", "https://user:secret@"),
        CDN.replace(".com/", ".com:8443/"),
        CDN.replace(
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
        ),
        CDN.replace(
            "release-assets.githubusercontent.com",
            "release-assets.githubusercontent.com.evil.test",
        ),
        CDN.replace("1298345475", "1234"),
        CDN.replace("c9c92616-728b-4ebf-8909-7e8e41fa9739", "invalid"),
        format!("{CDN}#fragment"),
    ] {
        assert!(!allows(&[LATEST], &next), "{next}");
    }
}

#[test]
fn rejects_cycles_and_every_redirect_after_the_asset_host() {
    assert!(!allows(&[], CDN));
    assert!(!allows(&[LATEST], LATEST));
    assert!(!allows(&[TAGGED], TAGGED));
    assert!(!allows(&[LATEST, TAGGED], TAGGED));
    assert!(!allows(&[LATEST, CDN], CDN));
    assert!(!allows(&[LATEST, TAGGED, CDN], CDN));
    assert!(!allows(&[CDN], TAGGED));
}

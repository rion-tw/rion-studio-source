//! Bounded transport compatibility for the existing public GitHub release endpoint.
//! Other update origins remain direct-response only; payload trust is still Minisign + SHA-256.

use url::Url;

const RELEASE_PREFIX: &str = "/rion-tw/rion-studio/releases/";
// Public repository identity observed with the v22 configuration audit.
const ASSET_PREFIX: &str = "/github-production-release-asset/1298345475/";
const ASSET_NAMES: [&str; 3] = [
    "latest.json",
    "Rion.Studio-mac.app.tar.gz",
    "Rion.Studio-win.exe",
];

pub(super) fn permits_redirect(previous: &[Url], next: &Url) -> bool {
    if previous.is_empty() || previous.len() > 2 || !is_secure(next) {
        return false;
    }
    let Some((initial_latest, asset)) = release_asset(&previous[0]) else {
        return false;
    };
    if previous.len() == 2
        && (!initial_latest || release_asset(&previous[1]) != Some((false, asset)))
    {
        return false;
    }
    if next.host_str() == Some("github.com") {
        return previous.len() == 1
            && initial_latest
            && release_asset(next) == Some((false, asset));
    }
    if next.host_str() != Some("release-assets.githubusercontent.com") {
        return false;
    }
    // An asset URL is terminal: no CDN-to-CDN, off-origin, or repeated redirect.
    next.path()
        .strip_prefix(ASSET_PREFIX)
        .is_some_and(|identity| uuid::Uuid::parse_str(identity).is_ok())
}

fn is_secure(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn release_asset(url: &Url) -> Option<(bool, &str)> {
    if !is_secure(url) || url.host_str() != Some("github.com") || url.query().is_some() {
        return None;
    }
    let path = url.path().strip_prefix(RELEASE_PREFIX)?;
    if let Some(asset) = path.strip_prefix("latest/download/") {
        return ASSET_NAMES.contains(&asset).then_some((true, asset));
    }
    let (tag, asset) = path.strip_prefix("download/")?.split_once('/')?;
    let version = tag.strip_prefix('v')?;
    let parsed = semver::Version::parse(version).ok()?;
    (parsed.to_string() == version && ASSET_NAMES.contains(&asset)).then_some((false, asset))
}

#[cfg(test)]
mod tests;

pub(crate) const URL: &str = "rion-start://home/";
pub(crate) const HTML: &str = include_str!("../../src/shared/generated/workspace-start.html");

pub(crate) fn is_start_url(value: &str) -> bool {
    matches!(
        value,
        URL | "http://rion-start.home/" | "https://rion-start.home/"
    )
}

pub(crate) fn native_url(value: &str) -> &str {
    if value == URL && cfg!(windows) {
        "http://rion-start.home/"
    } else {
        value
    }
}

pub(crate) fn can_serve(label: &str, method: &str, url: &str) -> bool {
    method == "GET"
        && is_start_url(url)
        && label.starts_with("workspace-web-")
        && !label.starts_with("workspace-web-chrome-")
}

pub(crate) fn appearance_script(language: &str, theme: &str) -> String {
    let language = match language {
        "zh-TW" | "zh-CN" | "ja" => language,
        _ => "en",
    };
    let theme = if theme == "dark" { "dark" } else { "light" };
    format!(
        "if (['rion-start://home/', 'http://rion-start.home/', 'https://rion-start.home/'].includes(location.href)) {{ document.documentElement.lang = '{language}'; document.documentElement.dataset.theme = '{theme}'; document.documentElement.style.colorScheme = '{theme}'; }}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_resource_is_bounded_to_website_views_on_both_transports() {
        for (platform, url) in [("macos", URL), ("windows", "http://rion-start.home/")] {
            assert!(can_serve("workspace-web-exact", "GET", url), "{platform}");
            for label in ["main", "game-role-owner", "workspace-web-chrome-owner"] {
                assert!(!can_serve(label, "GET", url), "{platform}: {label}");
            }
            assert!(!can_serve("workspace-web-exact", "POST", url), "{platform}");
            assert!(
                !can_serve("workspace-web-exact", "GET", &format!("{url}?page=other")),
                "{platform}"
            );
        }
        assert!(!is_start_url("rion-start://other/"));
    }
}

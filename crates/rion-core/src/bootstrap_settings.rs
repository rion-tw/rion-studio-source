use rion_platform::Platform;

const BASE_SWITCHES: &[&str] = &[
    "no-first-run",
    "no-default-browser-check",
    "disable-default-apps",
    "disable-component-extensions-with-background-pages",
    "metrics-recording-only",
    "no-service-autorun",
    "disable-search-engine-choice-screen",
];
const BACKGROUND_FEATURES_TO_DISABLE: &[&str] = &["MediaRouter", "OptimizationHints", "Translate"];

/// Returns the static, non-graphics arguments used only by WebView2.
///
/// WKWebView does not consume Chromium command-line arguments. Graphics pipeline
/// selection and acceleration are intentionally left to the operating-system
/// WebView runtime on both platforms.
pub fn additional_browser_arguments(
    platform: Platform,
    current_disable_features: &str,
) -> Vec<String> {
    if matches!(platform, Platform::Macos) {
        return Vec::new();
    }

    let mut arguments = BASE_SWITCHES
        .iter()
        .map(|name| format!("--{name}"))
        .collect::<Vec<_>>();
    arguments.push(format!(
        "--disable-features={}",
        merge_comma_separated(
            current_disable_features,
            BACKGROUND_FEATURES_TO_DISABLE.iter().copied(),
        )
    ));
    arguments
}

fn merge_comma_separated<'a>(
    current: &'a str,
    additions: impl IntoIterator<Item = &'a str>,
) -> String {
    let mut output = Vec::<String>::new();
    for value in current.split(',').chain(additions) {
        let value = value.trim();
        if !value.is_empty() && !output.iter().any(|candidate| candidate == value) {
            output.push(value.to_owned());
        }
    }
    output.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    const RETIRED_GRAPHICS_ARGUMENTS: &[&str] = &[
        "force-high-performance-gpu",
        "enable-gpu-rasterization",
        "ignore-gpu-blocklist",
        "enable-unsafe-webgpu",
        "disable-frame-rate-limit",
        "disable-gpu-vsync",
        "disable-gpu-driver-bug-workarounds",
        "use-angle",
        "use-vulkan",
        "Vulkan",
        "UseEcoQoSForBackgroundProcess",
    ];

    #[test]
    fn windows_arguments_keep_non_graphics_defaults_and_merge_disabled_features() {
        let arguments =
            additional_browser_arguments(Platform::Windows, "ExistingDisabled,MediaRouter");

        for name in BASE_SWITCHES {
            assert!(arguments.contains(&format!("--{name}")));
        }
        assert!(
            arguments.contains(
                &"--disable-features=ExistingDisabled,MediaRouter,OptimizationHints,Translate"
                    .to_owned()
            )
        );
        assert_no_retired_graphics_arguments(&arguments);
    }

    #[test]
    fn macos_does_not_receive_chromium_arguments() {
        let arguments = additional_browser_arguments(Platform::Macos, "ExistingDisabled");
        assert!(arguments.is_empty());
        assert_no_retired_graphics_arguments(&arguments);
    }

    fn assert_no_retired_graphics_arguments(arguments: &[String]) {
        for retired in RETIRED_GRAPHICS_ARGUMENTS {
            assert!(
                arguments.iter().all(|argument| !argument.contains(retired)),
                "retired graphics argument returned: {retired}"
            );
        }
    }
}

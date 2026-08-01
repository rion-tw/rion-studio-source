use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::{
    app::AppCore,
    error::{CoreError, CoreResult},
    model::{BrowserProxyEndpointRecord, BrowserProxySettingsRecord},
};
use serde_json::Value;

const INVALID_CONFIGURATION_CODE: &str = "BROWSER_PROXY_INVALID_CONFIGURATION";

pub fn default_browser_proxy_settings() -> BrowserProxySettingsRecord {
    BrowserProxySettingsRecord {
        mode: "system".to_owned(),
        custom: None,
    }
}

pub fn normalize_browser_proxy_settings(
    mut settings: BrowserProxySettingsRecord,
) -> CoreResult<BrowserProxySettingsRecord> {
    settings.mode = settings.mode.trim().to_ascii_lowercase();
    if let Some(endpoint) = settings.custom.take() {
        settings.custom = Some(normalize_endpoint(endpoint)?);
    }
    validate_browser_proxy_settings(&settings)?;
    Ok(settings)
}

pub fn validate_browser_proxy_settings(settings: &BrowserProxySettingsRecord) -> CoreResult<()> {
    match settings.mode.as_str() {
        "system" => Ok(()),
        "custom" if settings.custom.is_some() => Ok(()),
        "custom" => invalid("A local proxy endpoint is required in custom mode."),
        _ => invalid("Proxy mode must be system or custom."),
    }
}

fn normalize_endpoint(
    mut endpoint: BrowserProxyEndpointRecord,
) -> CoreResult<BrowserProxyEndpointRecord> {
    endpoint.protocol = endpoint.protocol.trim().to_ascii_lowercase();
    if !matches!(endpoint.protocol.as_str(), "http" | "socks5") {
        return invalid("Proxy protocol must be HTTP or SOCKS5.");
    }
    if !(1..=65_535).contains(&endpoint.port) {
        return invalid("Proxy port must be between 1 and 65535.");
    }

    let host = endpoint.host.trim();
    endpoint.host = if host.eq_ignore_ascii_case("localhost") {
        Ipv4Addr::LOCALHOST.to_string()
    } else {
        let unwrapped = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host);
        match unwrapped.parse::<IpAddr>() {
            Ok(IpAddr::V4(address)) if address == Ipv4Addr::LOCALHOST => address.to_string(),
            Ok(IpAddr::V6(address)) if address == Ipv6Addr::LOCALHOST => address.to_string(),
            _ => return invalid("Proxy host must be localhost, 127.0.0.1, or ::1."),
        }
    };
    Ok(endpoint)
}

fn invalid<T>(message: &str) -> CoreResult<T> {
    Err(CoreError::Domain {
        code: INVALID_CONFIGURATION_CODE,
        message: message.to_owned(),
    })
}

impl AppCore {
    pub(crate) fn get_browser_proxy_settings_value(&self) -> CoreResult<Value> {
        serde_json::to_value(self.read_scalar_state::<BrowserProxySettingsRecord>(
            "browserProxySettings",
            "browser proxy settings are missing",
        )?)
        .map_err(|error| CoreError::Internal(error.to_string()))
    }

    pub(crate) fn replace_browser_proxy_settings_value(
        &self,
        settings: BrowserProxySettingsRecord,
    ) -> CoreResult<Value> {
        let settings = normalize_browser_proxy_settings(settings)?;
        self.replace_scalar_state("browserProxySettings", settings.clone())?;
        serde_json::to_value(settings).map_err(|error| CoreError::Internal(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(protocol: &str, host: &str, port: u32) -> BrowserProxySettingsRecord {
        BrowserProxySettingsRecord {
            mode: "custom".to_owned(),
            custom: Some(BrowserProxyEndpointRecord {
                protocol: protocol.to_owned(),
                host: host.to_owned(),
                port,
            }),
        }
    }

    #[test]
    fn normalizes_supported_loopback_endpoints() {
        for (host, expected) in [
            ("localhost", "127.0.0.1"),
            ("127.0.0.1", "127.0.0.1"),
            ("[::1]", "::1"),
        ] {
            let settings = normalize_browser_proxy_settings(custom("HTTP", host, 10_090))
                .expect("supported endpoint");
            let endpoint = settings.custom.expect("custom endpoint");
            assert_eq!(endpoint.protocol, "http");
            assert_eq!(endpoint.host, expected);
        }
    }

    #[test]
    fn rejects_remote_auth_url_and_injection_inputs() {
        for host in [
            "192.0.2.1",
            "user:pass@127.0.0.1",
            "http://127.0.0.1",
            "127.0.0.1/path",
            "127.0.0.1?flag=true",
            "127.0.0.1 --disable-web-security",
        ] {
            let error = normalize_browser_proxy_settings(custom("http", host, 8080))
                .expect_err("invalid host");
            assert_eq!(error.payload().code, INVALID_CONFIGURATION_CODE);
        }
    }

    #[test]
    fn rejects_invalid_protocol_port_and_missing_custom_endpoint() {
        for settings in [
            custom("https", "127.0.0.1", 8080),
            custom("http", "127.0.0.1", 0),
            custom("socks5", "::1", 65_536),
            BrowserProxySettingsRecord {
                mode: "custom".to_owned(),
                custom: None,
            },
        ] {
            let error = normalize_browser_proxy_settings(settings).expect_err("invalid settings");
            assert_eq!(error.payload().code, INVALID_CONFIGURATION_CODE);
        }
    }
}

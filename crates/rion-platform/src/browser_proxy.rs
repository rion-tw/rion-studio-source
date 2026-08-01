use std::{
    net::{IpAddr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::PlatformError;

pub const BROWSER_PROXY_PREFLIGHT_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserProxyProtocol {
    Http,
    Socks5,
}

impl BrowserProxyProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Socks5 => "socks5",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProxyEndpoint {
    pub protocol: BrowserProxyProtocol,
    pub host: IpAddr,
    pub port: u16,
}

impl BrowserProxyEndpoint {
    pub fn validate(&self) -> Result<(), PlatformError> {
        if !self.host.is_loopback() || self.port == 0 {
            return Err(PlatformError::Operation(
                "browser proxy endpoint must be a loopback address with a non-zero port".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn socket_address(&self) -> Result<SocketAddr, PlatformError> {
        self.validate()?;
        Ok(SocketAddr::new(self.host, self.port))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserProxyPreflight {
    pub duration_ms: u64,
}

pub fn preflight_browser_proxy(
    endpoint: &BrowserProxyEndpoint,
) -> Result<BrowserProxyPreflight, PlatformError> {
    preflight_browser_proxy_with(endpoint, |address, timeout| {
        TcpStream::connect_timeout(&address, timeout).map(drop)
    })
}

fn preflight_browser_proxy_with(
    endpoint: &BrowserProxyEndpoint,
    connect: impl FnOnce(SocketAddr, Duration) -> std::io::Result<()>,
) -> Result<BrowserProxyPreflight, PlatformError> {
    let address = endpoint.socket_address()?;
    let started_at = Instant::now();
    connect(address, BROWSER_PROXY_PREFLIGHT_TIMEOUT).map_err(|error| {
        PlatformError::Operation(format!(
            "local browser proxy {address} is unavailable after {} ms: {error}",
            started_at.elapsed().as_millis()
        ))
    })?;
    Ok(BrowserProxyPreflight {
        duration_ms: started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub fn browser_proxy_fingerprint(endpoint: Option<&BrowserProxyEndpoint>) -> String {
    endpoint.map_or_else(
        || "system".to_owned(),
        |endpoint| {
            format!(
                "{}|{}|{}",
                endpoint.protocol.as_str(),
                endpoint.host,
                endpoint.port
            )
        },
    )
}

pub fn webview2_browser_arguments(
    base_arguments: &[String],
    endpoint: Option<&BrowserProxyEndpoint>,
) -> Result<String, PlatformError> {
    let mut arguments = base_arguments
        .iter()
        .filter(|argument| !argument.starts_with("--proxy-server="))
        .cloned()
        .collect::<Vec<_>>();
    if let Some(endpoint) = endpoint {
        endpoint.validate()?;
        let host = match endpoint.host {
            IpAddr::V4(address) => address.to_string(),
            IpAddr::V6(address) => format!("[{address}]"),
        };
        arguments.push(format!(
            "--proxy-server={}://{host}:{}",
            endpoint.protocol.as_str(),
            endpoint.port
        ));
    }
    Ok(arguments.join(" "))
}

#[cfg(test)]
mod tests {
    use std::{
        io::ErrorKind,
        net::{Ipv4Addr, Ipv6Addr},
    };

    use super::*;

    fn endpoint(protocol: BrowserProxyProtocol, host: IpAddr, port: u16) -> BrowserProxyEndpoint {
        BrowserProxyEndpoint {
            protocol,
            host,
            port,
        }
    }

    #[test]
    fn preflight_connects_to_a_loopback_endpoint_with_the_fixed_timeout() {
        let result = preflight_browser_proxy_with(
            &endpoint(
                BrowserProxyProtocol::Http,
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                10_090,
            ),
            |address, timeout| {
                assert_eq!(address, "127.0.0.1:10090".parse().unwrap());
                assert_eq!(timeout, BROWSER_PROXY_PREFLIGHT_TIMEOUT);
                Ok(())
            },
        )
        .unwrap();

        assert!(result.duration_ms <= 300);
    }

    #[test]
    fn preflight_rejects_non_loopback_refused_and_timed_out_endpoints() {
        let remote = endpoint(
            BrowserProxyProtocol::Http,
            "192.0.2.1".parse().unwrap(),
            8080,
        );
        assert!(preflight_browser_proxy_with(&remote, |_, _| Ok(())).is_err());

        let local = endpoint(
            BrowserProxyProtocol::Socks5,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            10_090,
        );
        for kind in [ErrorKind::ConnectionRefused, ErrorKind::TimedOut] {
            assert!(
                preflight_browser_proxy_with(&local, |_, _| Err(std::io::Error::from(kind)))
                    .is_err()
            );
        }
    }

    #[test]
    fn webview2_arguments_merge_one_proxy_and_bracket_ipv6() {
        let base = vec![
            "--no-first-run".to_owned(),
            "--proxy-server=http://stale.invalid:99".to_owned(),
        ];
        let arguments = webview2_browser_arguments(
            &base,
            Some(&endpoint(
                BrowserProxyProtocol::Socks5,
                IpAddr::V6(Ipv6Addr::LOCALHOST),
                10_090,
            )),
        )
        .unwrap();

        assert_eq!(arguments.matches("--proxy-server=").count(), 1);
        assert!(arguments.contains("--proxy-server=socks5://[::1]:10090"));
        assert!(!arguments.contains("stale.invalid"));
        assert_eq!(
            webview2_browser_arguments(&base, None).unwrap(),
            "--no-first-run"
        );
    }

    #[test]
    fn fingerprint_is_stable_and_distinguishes_settings() {
        let http = endpoint(
            BrowserProxyProtocol::Http,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            8080,
        );
        let socks = endpoint(
            BrowserProxyProtocol::Socks5,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            8080,
        );
        assert_eq!(browser_proxy_fingerprint(None), "system");
        assert_eq!(
            browser_proxy_fingerprint(Some(&http)),
            browser_proxy_fingerprint(Some(&http.clone()))
        );
        assert_ne!(
            browser_proxy_fingerprint(Some(&http)),
            browser_proxy_fingerprint(Some(&socks))
        );
    }
}

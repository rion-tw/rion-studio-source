use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::Path,
    time::Duration,
};

use reqwest::{StatusCode, blocking::Client, redirect::Policy};
use thiserror::Error;
use url::Url;

use crate::{MAX_UPDATE_ARTIFACT_BYTES, MAX_UPDATE_MANIFEST_BYTES};

const UPDATE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const UPDATE_MANIFEST_NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_ARTIFACT_NETWORK_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const DOWNLOAD_BUFFER_BYTES: usize = 64 * 1024;

pub trait UpdateTransport: Send + Sync {
    fn fetch_manifest(&self, endpoint: &Url) -> Result<Vec<u8>, UpdateTransportError>;

    fn download_artifact(
        &self,
        url: &Url,
        destination: &Path,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<u64, UpdateTransportError>;
}

#[derive(Clone)]
pub struct ReqwestUpdateTransport {
    client: Client,
}

impl ReqwestUpdateTransport {
    pub fn new() -> Result<Self, UpdateTransportError> {
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(UPDATE_CONNECT_TIMEOUT)
            .user_agent("Rion-Studio-Chromium-Updater/23")
            .build()
            .map_err(UpdateTransportError::Request)?;
        Ok(Self { client })
    }

    fn get(
        &self,
        url: &Url,
        deadline: Duration,
    ) -> Result<reqwest::blocking::Response, UpdateTransportError> {
        let response = self
            .client
            .get(url.clone())
            .timeout(deadline)
            .header(
                reqwest::header::ACCEPT,
                "application/octet-stream, application/json",
            )
            .send()
            .map_err(UpdateTransportError::Request)?;
        if response.status() != StatusCode::OK {
            return Err(UpdateTransportError::HttpStatus(response.status().as_u16()));
        }
        Ok(response)
    }
}

impl UpdateTransport for ReqwestUpdateTransport {
    fn fetch_manifest(&self, endpoint: &Url) -> Result<Vec<u8>, UpdateTransportError> {
        let response = self.get(endpoint, UPDATE_MANIFEST_NETWORK_TIMEOUT)?;
        if response
            .content_length()
            .is_some_and(|length| length == 0 || length > MAX_UPDATE_MANIFEST_BYTES as u64)
        {
            return Err(UpdateTransportError::ManifestTooLarge);
        }
        read_bounded(response, MAX_UPDATE_MANIFEST_BYTES as u64).map_err(|error| match error {
            BoundedReadError::Io(error) => UpdateTransportError::Io(error),
            BoundedReadError::TooLarge => UpdateTransportError::ManifestTooLarge,
            BoundedReadError::Empty => UpdateTransportError::ManifestEmpty,
        })
    }

    fn download_artifact(
        &self,
        url: &Url,
        destination: &Path,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<u64, UpdateTransportError> {
        let mut response = self.get(url, UPDATE_ARTIFACT_NETWORK_TIMEOUT)?;
        let expected = response.content_length();
        if expected.is_some_and(|length| length == 0 || length > MAX_UPDATE_ARTIFACT_BYTES) {
            return Err(UpdateTransportError::ArtifactTooLarge);
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options
            .open(destination)
            .map_err(UpdateTransportError::Io)?;
        let mut downloaded = 0_u64;
        let mut buffer = [0_u8; DOWNLOAD_BUFFER_BYTES];
        loop {
            let read = response
                .read(&mut buffer)
                .map_err(UpdateTransportError::Io)?;
            if read == 0 {
                break;
            }
            downloaded = downloaded
                .checked_add(read as u64)
                .filter(|bytes| *bytes <= MAX_UPDATE_ARTIFACT_BYTES)
                .ok_or(UpdateTransportError::ArtifactTooLarge)?;
            output
                .write_all(&buffer[..read])
                .map_err(UpdateTransportError::Io)?;
            progress(downloaded, expected);
        }
        if downloaded == 0 {
            return Err(UpdateTransportError::ArtifactEmpty);
        }
        if expected.is_some_and(|length| length != downloaded) {
            return Err(UpdateTransportError::ContentLengthMismatch);
        }
        output.sync_all().map_err(UpdateTransportError::Io)?;
        Ok(downloaded)
    }
}

#[derive(Debug, Error)]
pub enum UpdateTransportError {
    #[error("UPDATE_NETWORK_REQUEST_FAILED")]
    Request(#[source] reqwest::Error),
    #[error("UPDATE_NETWORK_HTTP_STATUS_{0}")]
    HttpStatus(u16),
    #[error("UPDATE_NETWORK_IO_FAILED")]
    Io(#[source] std::io::Error),
    #[error("UPDATE_MANIFEST_EMPTY")]
    ManifestEmpty,
    #[error("UPDATE_MANIFEST_TOO_LARGE")]
    ManifestTooLarge,
    #[error("UPDATE_ARTIFACT_EMPTY")]
    ArtifactEmpty,
    #[error("UPDATE_ARTIFACT_TOO_LARGE")]
    ArtifactTooLarge,
    #[error("UPDATE_ARTIFACT_CONTENT_LENGTH_MISMATCH")]
    ContentLengthMismatch,
}

impl UpdateTransportError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Request(_) => "UPDATE_NETWORK_REQUEST_FAILED",
            Self::HttpStatus(_) => "UPDATE_NETWORK_HTTP_STATUS_INVALID",
            Self::Io(_) => "UPDATE_NETWORK_IO_FAILED",
            Self::ManifestEmpty => "UPDATE_MANIFEST_EMPTY",
            Self::ManifestTooLarge => "UPDATE_MANIFEST_TOO_LARGE",
            Self::ArtifactEmpty => "UPDATE_ARTIFACT_EMPTY",
            Self::ArtifactTooLarge => "UPDATE_ARTIFACT_TOO_LARGE",
            Self::ContentLengthMismatch => "UPDATE_ARTIFACT_CONTENT_LENGTH_MISMATCH",
        }
    }
}

#[derive(Debug)]
enum BoundedReadError {
    Io(std::io::Error),
    TooLarge,
    Empty,
}

fn read_bounded(mut input: impl Read, maximum: u64) -> Result<Vec<u8>, BoundedReadError> {
    let capacity = usize::try_from(maximum.min(1024 * 1024)).unwrap_or(1024 * 1024);
    let mut output = Vec::with_capacity(capacity);
    let mut limited = input.by_ref().take(maximum + 1);
    limited
        .read_to_end(&mut output)
        .map_err(BoundedReadError::Io)?;
    if output.is_empty() {
        return Err(BoundedReadError::Empty);
    }
    if output.len() as u64 > maximum {
        return Err(BoundedReadError::TooLarge);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn bounded_reader_distinguishes_empty_exact_and_oversized_responses() {
        assert!(matches!(
            read_bounded(Cursor::new(Vec::<u8>::new()), 4),
            Err(BoundedReadError::Empty)
        ));
        assert_eq!(read_bounded(Cursor::new(b"test"), 4).unwrap(), b"test");
        assert!(matches!(
            read_bounded(Cursor::new(b"large"), 4),
            Err(BoundedReadError::TooLarge)
        ));
    }

    #[test]
    fn transport_errors_expose_stable_non_secret_codes() {
        assert_eq!(
            UpdateTransportError::HttpStatus(503).code(),
            "UPDATE_NETWORK_HTTP_STATUS_INVALID"
        );
        assert_eq!(
            UpdateTransportError::ArtifactTooLarge.code(),
            "UPDATE_ARTIFACT_TOO_LARGE"
        );
    }
}

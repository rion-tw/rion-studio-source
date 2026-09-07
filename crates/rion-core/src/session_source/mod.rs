//! Retained-source readers and explicit completeness assessment. No runtime fallback and no origin filtering.
pub(crate) mod cookies;
pub(crate) mod webkit;
pub(crate) mod webkit_sqlite;
pub(crate) mod windows;
pub(crate) type Result<T> = std::result::Result<T, &'static str>;

pub(crate) mod paths;
pub(crate) mod snapshot;

pub(crate) mod local_storage;
#[cfg(test)]
mod local_storage_tests;

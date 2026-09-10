use std::io;

#[derive(Debug, thiserror::Error)]
pub(crate) enum ExtensionPackageError {
    #[error("The Chrome Web Store package is temporarily unavailable.")]
    StoreUnavailable,
    #[error("The extension package exceeds the 128 MiB download limit.")]
    PackageTooLarge,
    #[error("The extension package exceeds the 512 MiB unpacked limit.")]
    UnpackedTooLarge,
    #[error("The extension package signature could not be verified.")]
    SignatureInvalid,
    #[error("The extension manifest is not supported.")]
    ManifestUnsupported,
    #[error("The extension package is invalid.")]
    PackageInvalid,
    #[error("Extension installation was cancelled.")]
    Cancelled,
    #[error("The extension package could not be stored.")]
    Filesystem(#[source] io::Error),
}

impl ExtensionPackageError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::StoreUnavailable => "EXTENSIONS_STORE_UNAVAILABLE",
            Self::PackageTooLarge => "EXTENSIONS_PACKAGE_TOO_LARGE",
            Self::UnpackedTooLarge => "EXTENSIONS_UNPACKED_TOO_LARGE",
            Self::SignatureInvalid => "EXTENSIONS_SIGNATURE_INVALID",
            Self::ManifestUnsupported => "EXTENSIONS_MANIFEST_UNSUPPORTED",
            Self::Cancelled => "EXTENSIONS_CANCELLED",
            Self::PackageInvalid | Self::Filesystem(_) => "EXTENSIONS_PACKAGE_FAILED",
        }
    }
}

impl From<io::Error> for ExtensionPackageError {
    fn from(error: io::Error) -> Self {
        Self::Filesystem(error)
    }
}

pub(crate) type Result<T> = std::result::Result<T, ExtensionPackageError>;

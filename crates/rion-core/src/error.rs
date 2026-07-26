use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{message}")]
    Domain { code: &'static str, message: String },
    #[error("state database failed: {0}")]
    StateDatabase(String),
    #[error("log database failed: {0}")]
    LogDatabase(String),
    #[error("data migration failed: {0}")]
    Migration(String),
    #[error("core is shutting down")]
    ShuttingDown,
    #[error("scheduled wait was cancelled")]
    WaitCancelled,
    #[error("platform operation failed: {0}")]
    Platform(String),
    #[error("{message}")]
    Effect { code: String, message: String },
    #[error("internal core failure: {0}")]
    Internal(String),
}

impl CoreError {
    pub fn code(&self) -> &str {
        match self {
            Self::InvalidInput(_) => "CORE_INPUT_INVALID",
            Self::Domain { code, .. } => code,
            Self::StateDatabase(_) => "CORE_STATE_DATABASE_FAILED",
            Self::LogDatabase(_) => "CORE_LOG_DATABASE_FAILED",
            Self::Migration(_) => "CORE_MIGRATION_FAILED",
            Self::ShuttingDown => "CORE_SHUTTING_DOWN",
            Self::WaitCancelled => "CORE_WAIT_CANCELLED",
            Self::Platform(_) => "CORE_PLATFORM_FAILED",
            Self::Effect { code, .. } => code,
            Self::Internal(_) => "CORE_INTERNAL_FAILED",
        }
    }

    pub fn payload(&self) -> CoreErrorPayload {
        CoreErrorPayload {
            code: self.code().to_owned(),
            message: self.to_string(),
        }
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::StateDatabase(value.to_string())
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/shared/generated/")]
pub struct CoreErrorPayload {
    pub code: String,
    pub message: String,
}

pub type CoreResult<T> = Result<T, CoreError>;

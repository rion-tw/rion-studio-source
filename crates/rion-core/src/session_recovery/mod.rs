pub(crate) mod commit;
pub(crate) mod fresh;
pub(crate) mod source;
pub(crate) mod stage;
pub mod types;
use crate::error::{CoreError, CoreResult};
use std::{
    collections::HashMap,
    sync::{Arc, atomic::AtomicBool},
};

#[derive(Default)]
pub(crate) struct Runtime {
    pub active: HashMap<String, Active>,
}
pub(crate) struct Active {
    pub attempt_id: String,
    pub record: types::RoleSessionRecoveryRecord,
    pub cancelled: Arc<AtomicBool>,
    pub effect_id: Option<String>,
    pub stage_attempt_id: Option<String>,
}
pub(crate) fn error(code: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: "Role session recovery cannot continue; retained source data was preserved."
            .to_owned(),
    }
}
pub(crate) fn uuid(value: &str) -> CoreResult<()> {
    if uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        Ok(())
    } else {
        Err(error("SESSION_RECOVERY_IDENTITY_INVALID"))
    }
}

/// Always retire the exact in-memory owner, including database/event failures.
/// Durable attempt history and owned files remain available for diagnosis.
pub(crate) struct ActiveGuard<'a> {
    pub runtime: &'a std::sync::Mutex<Runtime>,
    pub role: &'a str,
    pub attempt: &'a str,
}
impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.runtime.lock()
            && runtime
                .active
                .get(self.role)
                .is_some_and(|active| active.attempt_id == self.attempt)
        {
            runtime.active.remove(self.role);
        }
    }
}

#[cfg(test)]
mod tests;

pub(crate) mod upgrade;

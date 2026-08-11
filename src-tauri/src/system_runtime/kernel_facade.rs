//! Typed authority boundary between the native executor and AppCore's RuntimeKernel.

use super::*;

pub(super) fn seed_persisted_runtime_windows(
    core: &AppCore,
    game_windows: &[StateGameWindowRecord],
) -> Result<(), String> {
    for window in game_windows {
        core.apply_runtime_intent(RuntimeIntent::InitializeWindowContext(
            KernelWindowContextInitializeInput {
                persisted_name: Some(window.name.clone()),
                placement: window.placement.clone(),
                target_display: window.target_display.clone(),
                window_generation: 0,
                operation_id: uuid::Uuid::new_v4().to_string(),
                window_id: window.id.clone(),
            },
        ))
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

impl SystemRuntimeExecutor {
    pub(super) fn seed_kernel_dormant_tabs(
        &self,
        window_id: &str,
        tab_ids: Vec<String>,
    ) -> RuntimeResult<()> {
        self.core
            .apply_runtime_intent(RuntimeIntent::SeedDormantTabs {
                operation_id: uuid::Uuid::new_v4().to_string(),
                tab_ids,
                window_id: window_id.to_owned(),
            })
            .map(|_| ())
            .map_err(|error| RuntimeError::new("SYSTEM_RUNTIME_KERNEL_FAILED", error.to_string()))
    }

    pub(super) fn activate_kernel_tab(
        &self,
        expected_revision: u64,
        operation_id: OperationId,
        tab_id: RuntimeTabId,
        window_id: String,
    ) -> RuntimeResult<rion_core::RuntimeCommit> {
        self.core
            .apply_runtime_intent(RuntimeIntent::ActivateTab {
                expected_revision: Some(expected_revision),
                operation_id,
                tab_id,
                window_id,
            })
            .map_err(|error| RuntimeError::new("SYSTEM_RUNTIME_KERNEL_FAILED", error.to_string()))
    }

    pub(super) fn set_kernel_tab_activation_phase(
        &self,
        activation_attempt_id: OperationId,
        phase: RuntimeTabActivationPhaseRecord,
        tab_id: RuntimeTabId,
    ) -> RuntimeResult<RuntimeCommitStatus> {
        self.core
            .apply_runtime_intent(RuntimeIntent::SetTabActivationPhase {
                activation_attempt_id,
                operation_id: uuid::Uuid::new_v4().to_string(),
                phase,
                tab_id,
            })
            .map(|commit| commit.status)
            .map_err(|error| RuntimeError::new("SYSTEM_RUNTIME_KERNEL_FAILED", error.to_string()))
    }

    pub(super) fn report_system_surface_state_async(
        &self,
        role_id: String,
        reason: Option<String>,
        recovered: bool,
    ) {
        let core = Arc::clone(&self.core);
        tauri::async_runtime::spawn(async move {
            let command = if recovered {
                CoreCommand::EmbeddedSystemSurfaceRecovered { role_id }
            } else {
                CoreCommand::EmbeddedSystemSurfaceFailed { role_id, reason }
            };
            if let Err(error) = core.invoke_async(command).await {
                eprintln!("Asynchronous System WebView lifecycle projection failed: {error}");
            }
        });
    }

    pub(super) fn begin_runtime_launch_operation(
        &self,
        operation_id: &str,
        attempt_id: &str,
        tab_id: &str,
        window_generation: u64,
        surface_generation: u64,
    ) -> RuntimeResult<bool> {
        let window_id = self
            .presentation
            .tab_window(tab_id)
            .map_err(|message| RuntimeError::new("SYSTEM_RUNTIME_TAB_OWNER_INVALID", message))?;
        let commit = self
            .core
            .apply_runtime_intent(RuntimeIntent::BeginOperation(
                rion_core::RuntimeOperationRecord {
                    attempt_id: Some(LaunchAttemptId::new(attempt_id).map_err(|message| {
                        RuntimeError::new("SYSTEM_RUNTIME_IDENTITY_INVALID", message)
                    })?),
                    kind: "launchTab".to_owned(),
                    operation_id: OperationId::new(operation_id).map_err(|message| {
                        RuntimeError::new("SYSTEM_RUNTIME_IDENTITY_INVALID", message)
                    })?,
                    phase: RuntimeOperationPhase::Pending,
                    surface_generation: RuntimeSurfaceGeneration(surface_generation),
                    tab_id: Some(RuntimeTabId::new(tab_id).map_err(|message| {
                        RuntimeError::new("SYSTEM_RUNTIME_IDENTITY_INVALID", message)
                    })?),
                    terminal_code: None,
                    window_generation: RuntimeWindowGeneration(window_generation),
                    window_id,
                },
            ))
            .map_err(|error| {
                RuntimeError::new("SYSTEM_RUNTIME_KERNEL_FAILED", error.to_string())
            })?;
        Ok(commit.status == RuntimeCommitStatus::Applied)
    }

    pub(super) fn apply_runtime_native_event_for_operation(
        &self,
        operation_id: &str,
        event_kind: &str,
    ) -> RuntimeResult<RuntimeCommitStatus> {
        let kernel = self.core.runtime_kernel();
        let snapshot = kernel.snapshot().map_err(|error| {
            RuntimeError::new("SYSTEM_RUNTIME_KERNEL_FAILED", error.to_string())
        })?;
        let Some(operation) = snapshot.operations.get(operation_id) else {
            return Ok(RuntimeCommitStatus::Superseded);
        };
        let (Some(attempt_id), Some(tab_id)) =
            (operation.attempt_id.clone(), operation.tab_id.clone())
        else {
            return Ok(RuntimeCommitStatus::Superseded);
        };
        let commit = self
            .core
            .apply_runtime_intent(RuntimeIntent::NativeEvent(NativeRuntimeEvent {
                attempt_id,
                event_kind: event_kind.to_owned(),
                operation_id: operation.operation_id.clone(),
                surface_generation: operation.surface_generation,
                tab_id,
                window_generation: operation.window_generation,
            }))
            .map_err(|error| {
                RuntimeError::new("SYSTEM_RUNTIME_KERNEL_FAILED", error.to_string())
            })?;
        if commit.status == RuntimeCommitStatus::Applied && !commit.window_ids.is_empty() {
            self.presentation
                .refresh_desired_native_projections(&commit.window_ids)
                .map_err(|error| RuntimeError::new("SYSTEM_RUNTIME_PROJECTION_FAILED", error))?;
        }
        Ok(commit.status)
    }

    pub(super) fn terminalize_runtime_operation(
        &self,
        operation_id: &str,
        phase: RuntimeOperationPhase,
        terminal_code: Option<String>,
    ) -> RuntimeResult<RuntimeCommitStatus> {
        let commit = self
            .core
            .apply_runtime_intent(RuntimeIntent::TerminalizeOperation {
                operation_id: OperationId::new(operation_id).map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_IDENTITY_INVALID", message)
                })?,
                phase,
                terminal_code,
            })
            .map_err(|error| {
                RuntimeError::new("SYSTEM_RUNTIME_KERNEL_FAILED", error.to_string())
            })?;
        Ok(commit.status)
    }

    pub(super) fn fail_runtime_event_stream(
        &self,
        stream_id: &str,
        operation_ids: &[String],
        terminal_code: &str,
    ) -> RuntimeResult<RuntimeCommitStatus> {
        let operation_ids = operation_ids
            .iter()
            .map(|operation_id| {
                OperationId::new(operation_id).map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_IDENTITY_INVALID", message)
                })
            })
            .collect::<RuntimeResult<Vec<_>>>()?;
        let commit = self
            .core
            .apply_runtime_intent(RuntimeIntent::FailEventStream {
                operation_ids,
                source: "nativeEventStream".to_owned(),
                stream_id: OperationId::new(stream_id).map_err(|message| {
                    RuntimeError::new("SYSTEM_RUNTIME_IDENTITY_INVALID", message)
                })?,
                terminal_code: terminal_code.to_owned(),
            })
            .map_err(|error| {
                RuntimeError::new("SYSTEM_RUNTIME_KERNEL_FAILED", error.to_string())
            })?;
        if commit.status == RuntimeCommitStatus::Applied && !commit.window_ids.is_empty() {
            self.presentation
                .refresh_desired_native_projections(&commit.window_ids)
                .map_err(|error| RuntimeError::new("SYSTEM_RUNTIME_PROJECTION_FAILED", error))?;
        }
        Ok(commit.status)
    }
}

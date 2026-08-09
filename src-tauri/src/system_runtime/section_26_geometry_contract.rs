#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GeometryMutationScope {
    PositionOnly,
    WindowAndLayout,
}

#[derive(Clone, Debug)]
struct NativeWindowGeometrySnapshot {
    fullscreen: bool,
    maximized: bool,
    physical_position: (i32, i32),
    physical_size: (u32, u32),
}

struct ActiveGeometryGuard<'a> {
    state: &'a Mutex<RuntimeState>,
    window_id: String,
}

impl Drop for ActiveGeometryGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.active_geometry_windows.remove(&self.window_id);
        }
    }
}

impl SystemRuntimeExecutor {
    fn require_runtime_accepting(&self) -> RuntimeResult<()> {
        let shutdown_accepting = RuntimeShutdownState::from_raw(
            self.shutdown_state.load(Ordering::Acquire),
        ) == RuntimeShutdownState::Accepting;
        if shutdown_accepting && self.application_lifecycle.accepts_native_work() {
            Ok(())
        } else if !shutdown_accepting {
            Err(RuntimeError::new(
                "SYSTEM_RUNTIME_SHUTTING_DOWN",
                "The System WebView runtime is shutting down and cannot accept new native work.",
            ))
        } else {
            Err(RuntimeError::new(
                "SYSTEM_RUNTIME_SUSPENDED",
                "The System WebView runtime is suspended and cannot accept new native work.",
            ))
        }
    }

    fn layout_runtime_tab(&self, tab_id: &str) -> RuntimeResult<()> {
        self.layout_runtime_tab_projection(tab_id, None, false, true)
    }

    #[cfg(not(windows))]
    fn layout_runtime_tab_with_metrics(
        &self,
        tab_id: &str,
        metrics: WindowContentMetrics,
        skip_active_bounds: bool,
        publish_native_plan: bool,
    ) -> RuntimeResult<()> {
        self.layout_runtime_tab_projection(
            tab_id,
            Some(metrics),
            skip_active_bounds,
            publish_native_plan,
        )
    }

    fn layout_runtime_tab_projection(
        &self,
        tab_id: &str,
        metrics: Option<WindowContentMetrics>,
        skip_active_bounds: bool,
        publish_native_plan: bool,
    ) -> RuntimeResult<()> {
        self.require_runtime_accepting()?;
        let window_id = self.resolve_live_tab_window_id(tab_id)?;
        let (revision, lane) = self.native_window_mutations.issue(&window_id)?;
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Geometry,
            "layoutRuntimeTab",
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(SystemRuntimeOperationCompletionScope::NativeSubmission)
        .with_revision(revision)
        .with_tab(tab_id)
        .with_window(&window_id);
        let _guard = lane.lock_until(operation.required_deadline()).map_err(|_| {
            RuntimeError::new(
                "SYSTEM_GEOMETRY_APPLY_FAILED",
                "The native window mutation lane is unavailable.",
            )
        })?;
        self.require_runtime_accepting()?;
        if !self
            .native_window_mutations
            .is_latest(&window_id, revision)
        {
            self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                operation,
                "geometrySuperseded",
                NativeOperationStatus::Superseded,
                Some("SYSTEM_GEOMETRY_SUPERSEDED"),
            ));
            return Ok(());
        }
        let result = self.layout_runtime_tab_inner_with_metrics(
            tab_id,
            metrics,
            skip_active_bounds,
            publish_native_plan,
        );
        let receipt = match result.as_ref() {
            Ok(())
                if !self
                    .native_window_mutations
                    .is_latest(&window_id, revision) =>
            {
                NativeOperationReceipt::with_status(
                    operation,
                    "geometrySuperseded",
                    NativeOperationStatus::Superseded,
                    Some("SYSTEM_GEOMETRY_SUPERSEDED"),
                )
            }
            Ok(()) => NativeOperationReceipt::applied(operation, "geometryLayoutSubmitted"),
            Err(error) => {
                let receipt = NativeOperationReceipt::with_status(
                    operation,
                    "geometryLayoutProjectionFailed",
                    NativeOperationStatus::Failed,
                    Some(error.code),
                );
                if let Some(count) = error.rollback_error_count {
                    receipt.with_rollback_error_count(count as usize)
                } else {
                    receipt
                }
            }
        };
        self.record_native_operation_receipt(receipt);
        result
    }

    fn apply_window_geometry_target(
        &self,
        target: &EmbeddedLaunchTargetRecord,
        scope: GeometryMutationScope,
        trigger: &'static str,
    ) -> RuntimeResult<bool> {
        self.require_runtime_accepting()?;
        let Some(window) = self.window_for_id(&target.window_id) else {
            return Ok(false);
        };
        let (revision, lane) = self.native_window_mutations.issue(&target.window_id)?;
        let operation = NativeOperationContext::new(
            NativeOperationSubsystem::Geometry,
            trigger,
            PLATFORM_CALLBACK_TIMEOUT,
        )
        .with_completion_scope(if scope == GeometryMutationScope::PositionOnly {
            SystemRuntimeOperationCompletionScope::NativeAcknowledgement
        } else {
            SystemRuntimeOperationCompletionScope::NativeSubmission
        })
        .with_revision(revision)
        .with_window(&target.window_id);
        let _guard = lane.lock_until(operation.required_deadline()).map_err(|_| {
            RuntimeError::new(
                "SYSTEM_GEOMETRY_APPLY_FAILED",
                "The native window mutation lane is unavailable.",
            )
        })?;
        self.require_runtime_accepting()?;
        if !self
            .native_window_mutations
            .is_latest(&target.window_id, revision)
        {
            self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                operation,
                "geometrySuperseded",
                NativeOperationStatus::Superseded,
                Some("SYSTEM_GEOMETRY_SUPERSEDED"),
            ));
            return Ok(true);
        }
        {
            self.state()?
                .active_geometry_windows
                .insert(target.window_id.clone());
        }
        let _activity = ActiveGeometryGuard {
            state: &self.state,
            window_id: target.window_id.clone(),
        };

        let snapshot = native_window_geometry_snapshot(&window)?;
        let tab_ids = if scope == GeometryMutationScope::WindowAndLayout {
            self.live_tab_ids_for_window(&target.window_id)
        } else {
            Vec::new()
        };
        if let Err(apply_error) =
            self.apply_window_geometry_native(&window, target, scope, &tab_ids)
        {
            let rollback_errors =
                self.rollback_window_geometry_native(&window, &snapshot, scope, &tab_ids);
            let status = geometry_transaction_status(GeometryTransactionClassification {
                applied: false,
                native_truth_matches: false,
                rollback_attempted: true,
                rollback_error_count: rollback_errors.len(),
                superseded: false,
            });
            let mut receipt = NativeOperationReceipt::with_status(
                operation,
                if rollback_errors.is_empty() {
                    "geometryRolledBack"
                } else {
                    "geometryRollbackFailed"
                },
                status,
                Some(if rollback_errors.is_empty() {
                    "SYSTEM_GEOMETRY_APPLY_FAILED"
                } else {
                    "SYSTEM_GEOMETRY_ROLLBACK_FAILED"
                }),
            );
            if !rollback_errors.is_empty() {
                self.health.mark_unhealthy();
                receipt = receipt.with_rollback_error_count(rollback_errors.len());
            }
            self.record_native_operation_receipt(receipt);
            return Err(if rollback_errors.is_empty() {
                RuntimeError::new("SYSTEM_GEOMETRY_APPLY_FAILED", apply_error)
            } else {
                RuntimeError::new(
                    "SYSTEM_GEOMETRY_ROLLBACK_FAILED",
                    format!(
                        "Native window geometry failed: {apply_error}. Compensation also failed: {}. Restart Rion Studio to recover safely.",
                        rollback_errors.join("; ")
                    ),
                )
                .with_rollback_error_count(rollback_errors.len())
            });
        }

        if !self
            .native_window_mutations
            .is_latest(&target.window_id, revision)
        {
            let rollback_errors =
                self.rollback_window_geometry_native(&window, &snapshot, scope, &tab_ids);
            if rollback_errors.is_empty() {
                self.record_native_operation_receipt(NativeOperationReceipt::with_status(
                    operation,
                    "geometrySuperseded",
                    NativeOperationStatus::Superseded,
                    Some("SYSTEM_GEOMETRY_SUPERSEDED"),
                ));
                return Ok(true);
            }
            self.health.mark_unhealthy();
            self.record_native_operation_receipt(
                NativeOperationReceipt::with_status(
                    operation,
                    "geometrySupersededRollbackFailed",
                    NativeOperationStatus::Indeterminate,
                    Some("SYSTEM_GEOMETRY_ROLLBACK_FAILED"),
                )
                .with_rollback_error_count(rollback_errors.len()),
            );
            return Err(RuntimeError::new(
                "SYSTEM_GEOMETRY_ROLLBACK_FAILED",
                format!(
                    "A newer native window geometry request superseded this transaction, but compensation failed: {}.",
                    rollback_errors.join("; ")
                ),
            )
            .with_rollback_error_count(rollback_errors.len()));
        }

        let (readback, native_truth_matches) = match geometry_target_readback(&window, target) {
            Ok(readback) => readback,
            Err(readback_error) => {
                let rollback_errors =
                    self.rollback_window_geometry_native(&window, &snapshot, scope, &tab_ids);
                let rollback_failed = !rollback_errors.is_empty();
                if rollback_failed {
                    self.health.mark_unhealthy();
                }
                self.record_native_operation_receipt(
                    NativeOperationReceipt::with_status(
                        operation,
                        "geometryReadbackFailed",
                        if rollback_failed {
                            NativeOperationStatus::Indeterminate
                        } else {
                            NativeOperationStatus::Failed
                        },
                        Some(if rollback_failed {
                            "SYSTEM_GEOMETRY_ROLLBACK_FAILED"
                        } else {
                            "SYSTEM_GEOMETRY_APPLY_FAILED"
                        }),
                    )
                    .with_rollback_error_count(rollback_errors.len()),
                );
                return Err(RuntimeError::new(
                    if rollback_failed {
                        "SYSTEM_GEOMETRY_ROLLBACK_FAILED"
                    } else {
                        "SYSTEM_GEOMETRY_APPLY_FAILED"
                    },
                    readback_error.message,
                )
                .with_rollback_error_count(rollback_errors.len()));
            }
        };
        let commit_result = (|| -> RuntimeResult<()> {
            let mut state = self.state()?;
            let host = state.native_resources.display_hosts.get_mut(&target.window_id).ok_or_else(|| {
                RuntimeError::new(
                    "SYSTEM_GEOMETRY_APPLY_FAILED",
                    "The runtime display host disappeared before geometry could commit.",
                )
            })?;
            host.target = readback;
            Ok(())
        })();
        if let Err(commit_error) = commit_result {
            let rollback_errors =
                self.rollback_window_geometry_native(&window, &snapshot, scope, &tab_ids);
            let rollback_failed = !rollback_errors.is_empty();
            if rollback_failed {
                self.health.mark_unhealthy();
            }
            self.record_native_operation_receipt(
                NativeOperationReceipt::with_status(
                    operation,
                    "geometryCommitFailed",
                    if rollback_failed {
                        NativeOperationStatus::Indeterminate
                    } else {
                        NativeOperationStatus::Failed
                    },
                    Some(if rollback_failed {
                        "SYSTEM_GEOMETRY_ROLLBACK_FAILED"
                    } else {
                        commit_error.code
                    }),
                )
                .with_rollback_error_count(rollback_errors.len()),
            );
            return Err(commit_error);
        }
        let status = geometry_transaction_status(GeometryTransactionClassification {
            applied: true,
            native_truth_matches,
            rollback_attempted: false,
            rollback_error_count: 0,
            superseded: false,
        });
        self.record_native_operation_receipt(NativeOperationReceipt::with_status(
            operation,
            if scope == GeometryMutationScope::PositionOnly {
                "geometryPositionAcknowledged"
            } else if target.presentation != "normal" {
                "geometryModeSubmitted"
            } else {
                "geometryLayoutSubmitted"
            },
            status,
            (!native_truth_matches).then_some("SYSTEM_GEOMETRY_READBACK_ADJUSTED"),
        ));
        drop(_activity);
        self.publish_projection();
        Ok(true)
    }

    fn apply_window_geometry_native(
        &self,
        window: &Window,
        target: &EmbeddedLaunchTargetRecord,
        scope: GeometryMutationScope,
        tab_ids: &[String],
    ) -> Result<(), String> {
        if scope == GeometryMutationScope::WindowAndLayout {
            if window.is_fullscreen().unwrap_or(false) {
                window.set_fullscreen(false).map_err(|error| error.to_string())?;
            }
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|error| error.to_string())?;
            }
        }
        let (physical_x, physical_y) =
            physical_window_position(target.bounds.x, target.bounds.y, target.scale_factor);
        window
            .set_position(PhysicalPosition::new(physical_x, physical_y))
            .map_err(|error| error.to_string())?;
        if scope == GeometryMutationScope::WindowAndLayout {
            window
                .set_size(LogicalSize::new(
                    target.bounds.width.max(1) as f64,
                    target.bounds.height.max(1) as f64,
                ))
                .map_err(|error| error.to_string())?;
            self.submit_window_tab_layouts(tab_ids);
            match target.presentation.as_str() {
                "fullscreen" => window
                    .set_fullscreen(true)
                    .map_err(|error| error.to_string())?,
                "maximized" => window.maximize().map_err(|error| error.to_string())?,
                _ => {}
            }
        }
        Ok(())
    }

    fn rollback_window_geometry_native(
        &self,
        window: &Window,
        snapshot: &NativeWindowGeometrySnapshot,
        scope: GeometryMutationScope,
        _tab_ids: &[String],
    ) -> Vec<String> {
        let mut errors = Vec::new();
        if window.is_fullscreen().unwrap_or(false)
            && let Err(error) = window.set_fullscreen(false)
        {
            errors.push(format!("exit fullscreen: {error}"));
        }
        if window.is_maximized().unwrap_or(false)
            && let Err(error) = window.unmaximize()
        {
            errors.push(format!("unmaximize: {error}"));
        }
        if let Err(error) = window.set_position(PhysicalPosition::new(
            snapshot.physical_position.0,
            snapshot.physical_position.1,
        )) {
            errors.push(format!("position: {error}"));
        }
        if scope == GeometryMutationScope::WindowAndLayout {
            if let Err(error) = window.set_size(tauri::PhysicalSize::new(
                snapshot.physical_size.0,
                snapshot.physical_size.1,
            )) {
                errors.push(format!("size: {error}"));
            }
            if snapshot.fullscreen {
                if let Err(error) = window.set_fullscreen(true) {
                    errors.push(format!("fullscreen: {error}"));
                }
            } else if snapshot.maximized
                && let Err(error) = window.maximize()
            {
                errors.push(format!("maximize: {error}"));
            }
        }
        errors
    }

    fn submit_window_tab_layouts(&self, tab_ids: &[String]) {
        for tab_id in tab_ids {
            if let Err(error) = self.layout_runtime_tab_inner(tab_id) {
                // Tab layout is a projection of the already-committed window
                // frame. It must never roll the frame back or poison unrelated
                // windows. A disconnected role surface is recovered by the
                // layout path; lifecycle races simply retire this projection.
                eprintln!(
                    "Native runtime tab layout projection was deferred: tab={tab_id} code={} error={}",
                    error.code, error.message
                );
            }
        }
    }
}

fn native_window_geometry_snapshot(window: &Window) -> RuntimeResult<NativeWindowGeometrySnapshot> {
    let position = window.outer_position().map_err(RuntimeError::tauri)?;
    let size = window.inner_size().map_err(RuntimeError::tauri)?;
    Ok(NativeWindowGeometrySnapshot {
        fullscreen: window.is_fullscreen().unwrap_or(false),
        maximized: window.is_maximized().unwrap_or(false),
        physical_position: (position.x, position.y),
        physical_size: (size.width, size.height),
    })
}

fn geometry_target_readback(
    window: &Window,
    target: &EmbeddedLaunchTargetRecord,
) -> RuntimeResult<(EmbeddedLaunchTargetRecord, bool)> {
    let position = window.outer_position().map_err(RuntimeError::tauri)?;
    let size = window.inner_size().map_err(RuntimeError::tauri)?;
    let monitor = window.current_monitor().ok().flatten();
    let scale = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .or_else(|| window.scale_factor().ok())
        .unwrap_or(target.scale_factor)
        .max(f64::EPSILON);
    let mode_submitted = target.presentation != "normal";
    let actual_x = if mode_submitted {
        target.bounds.x
    } else {
        (position.x as f64 / scale).round() as i32
    };
    let actual_y = if mode_submitted {
        target.bounds.y
    } else {
        (position.y as f64 / scale).round() as i32
    };
    let actual_width = if mode_submitted {
        target.bounds.width.max(1)
    } else {
        (size.width as f64 / scale).round().max(1.0) as i32
    };
    let actual_height = if mode_submitted {
        target.bounds.height.max(1)
    } else {
        (size.height as f64 / scale).round().max(1.0) as i32
    };
    let matches = (actual_x - target.bounds.x).abs() <= 1
        && (actual_y - target.bounds.y).abs() <= 1
        && (actual_width - target.bounds.width.max(1)).abs() <= 1
        && (actual_height - target.bounds.height.max(1)).abs() <= 1;
    let mut readback = target.clone();
    readback.bounds.x = actual_x;
    readback.bounds.y = actual_y;
    readback.bounds.width = actual_width;
    readback.bounds.height = actual_height;
    readback.scale_factor = scale;
    if let Some(monitor) = monitor {
        let monitor_scale = monitor.scale_factor().max(f64::EPSILON);
        let work_area = monitor.work_area();
        readback.display_id = super::monitor_id(&monitor);
        readback.work_area = StatePixelBoundsRecord {
            x: (work_area.position.x as f64 / monitor_scale).round() as i32,
            y: (work_area.position.y as f64 / monitor_scale).round() as i32,
            width: (work_area.size.width as f64 / monitor_scale).round() as i32,
            height: (work_area.size.height as f64 / monitor_scale).round() as i32,
        };
    }
    Ok((readback, matches))
}

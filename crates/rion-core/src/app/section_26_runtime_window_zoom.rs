// Keep zoom replay retention at the same order and bounded horizon as the
// RuntimeKernel operation ledger. Their populations are independent, so a
// retained-kernel/evicted-receipt Duplicate is still handled explicitly below.
const RETAINED_RUNTIME_WINDOW_ZOOM_RECEIPTS: usize = 4_096;
const DEFAULT_RUNTIME_WINDOW_ZOOM_FACTOR: f64 = 1.0;
const RUNTIME_WINDOW_ZOOM_STEP: f64 = 0.05;
const MIN_RUNTIME_WINDOW_ZOOM_FACTOR: f64 = 0.25;
const MAX_RUNTIME_WINDOW_ZOOM_FACTOR: f64 = 5.0;

#[derive(Clone)]
struct RuntimeWindowZoomReceiptEntry {
    fingerprint: String,
    receipt: crate::model::RuntimeWindowZoomReceiptRecord,
}

#[derive(Default)]
struct RuntimeWindowZoomReceiptLedger {
    entries: std::collections::HashMap<String, RuntimeWindowZoomReceiptEntry>,
    order: std::collections::VecDeque<String>,
}

struct RuntimeWindowZoomTerminal<'a> {
    operation_id: String,
    fingerprint: String,
    window_id: String,
    window_generation: u64,
    source_topology_revision: u64,
    topology_revision: u64,
    action: String,
    previous_zoom_factor: f64,
    next_zoom_factor: f64,
    status: &'a str,
    counts: Option<&'a crate::model::RuntimeWindowZoomNativeReceiptRecord>,
    failure_code: Option<String>,
}

fn runtime_window_zoom_error(code: &'static str, message: &'static str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

fn runtime_window_zoom_factor(current: f64, action: &str) -> f64 {
    let candidate = match action {
        "in" => current + RUNTIME_WINDOW_ZOOM_STEP,
        "out" => current - RUNTIME_WINDOW_ZOOM_STEP,
        "reset" => DEFAULT_RUNTIME_WINDOW_ZOOM_FACTOR,
        _ => current,
    };
    ((candidate * 100.0).round() / 100.0)
        .clamp(MIN_RUNTIME_WINDOW_ZOOM_FACTOR, MAX_RUNTIME_WINDOW_ZOOM_FACTOR)
}

fn runtime_window_zoom_failure_is_indeterminate(error: &CoreError) -> bool {
    let code = error.code();
    code.contains("COMPENSATION") || code.contains("UNKNOWN") || code.contains("QUARANTINE")
}

fn parse_runtime_window_zoom_native_receipt(
    outcome: crate::operation_actor::OperationOutcome,
    window_id: &str,
    window_generation: u64,
    topology_revision: u64,
    previous_zoom_factor: f64,
    next_zoom_factor: f64,
) -> CoreResult<crate::model::RuntimeWindowZoomNativeReceiptRecord> {
    let value_json = outcome
        .results
        .first()
        .and_then(|result| result.value_json.as_deref())
        .ok_or_else(|| {
            runtime_window_zoom_error(
                "RUNTIME_WINDOW_ZOOM_NATIVE_RECEIPT_MISSING",
                "The Chromium shell omitted its terminal runtime-window zoom receipt.",
            )
        })?;
    let receipt = serde_json::from_str::<crate::model::RuntimeWindowZoomNativeReceiptRecord>(
        value_json,
    )
    .map_err(|_| {
        runtime_window_zoom_error(
            "RUNTIME_WINDOW_ZOOM_NATIVE_RECEIPT_INVALID",
            "The Chromium shell returned an invalid runtime-window zoom receipt.",
        )
    })?;
    if receipt.window_id != window_id
        || receipt.window_generation != window_generation
        || receipt.topology_revision != topology_revision
        || receipt.previous_zoom_factor != previous_zoom_factor
        || receipt.next_zoom_factor != next_zoom_factor
        || receipt.status != "applied"
    {
        return Err(runtime_window_zoom_error(
            "RUNTIME_WINDOW_ZOOM_NATIVE_RECEIPT_STALE",
            "The Chromium shell returned a mismatched runtime-window zoom receipt.",
        ));
    }
    Ok(receipt)
}

impl AppCore {
    fn execute_runtime_window_zoom_native(
        &self,
        operation_id: &str,
        window_id: &str,
        window_generation: u64,
        topology_revision: u64,
        previous_zoom_factor: f64,
        next_zoom_factor: f64,
    ) -> CoreResult<crate::model::RuntimeWindowZoomNativeReceiptRecord> {
        let timeout = Duration::from_secs(15);
        let target = CoreEffectTarget {
            kind: CoreEffectTargetKind::App,
            handle_id: window_id.to_owned(),
        };
        let outcome = self.run_embedded_runtime_effect_plan(
            vec![crate::operation_actor::OperationStep {
                effect: crate::operation_actor::OperationEffect {
                    target: target.clone(),
                    action: CoreEffectAction::EmbeddedSetRuntimeWindowZoom {
                        window_id: window_id.to_owned(),
                        window_generation,
                        topology_revision,
                        zoom_factor: next_zoom_factor,
                        previous_zoom_factor,
                    },
                    timeout,
                    // A rejected Chromium result is terminal only after the shell has
                    // rolled back every surface it touched. Compensating that known
                    // rejection again would turn a pre-mutation stale fence into an
                    // indeterminate double failure. Transport uncertainty still causes
                    // OperationActor to dispatch the reverse effect.
                    compensate_on_rejected_result: false,
                },
                compensation: Some(crate::operation_actor::OperationEffect {
                    target,
                    action: CoreEffectAction::EmbeddedSetRuntimeWindowZoom {
                        window_id: window_id.to_owned(),
                        window_generation,
                        topology_revision,
                        zoom_factor: previous_zoom_factor,
                        previous_zoom_factor: next_zoom_factor,
                    },
                    timeout,
                    compensate_on_rejected_result: false,
                }),
            }],
            Some(operation_id),
        )?;
        parse_runtime_window_zoom_native_receipt(
            outcome,
            window_id,
            window_generation,
            topology_revision,
            previous_zoom_factor,
            next_zoom_factor,
        )
    }

    fn cached_runtime_window_zoom_receipt(
        &self,
        operation_id: &str,
        fingerprint: &str,
    ) -> CoreResult<Option<crate::model::RuntimeWindowZoomReceiptRecord>> {
        let ledger = self.runtime_window_zoom_receipts.lock().map_err(|_| {
            CoreError::Internal("runtime-window zoom receipt ledger poisoned".to_owned())
        })?;
        let Some(entry) = ledger.entries.get(operation_id) else {
            return Ok(None);
        };
        if entry.fingerprint != fingerprint {
            return Err(runtime_window_zoom_error(
                "RUNTIME_WINDOW_ZOOM_OPERATION_ID_REUSED",
                "A runtime-window zoom operation identity was reused for a different action.",
            ));
        }
        Ok(Some(entry.receipt.clone()))
    }

    fn retain_runtime_window_zoom_receipt(
        &self,
        operation_id: String,
        fingerprint: String,
        receipt: crate::model::RuntimeWindowZoomReceiptRecord,
    ) -> CoreResult<crate::model::RuntimeWindowZoomReceiptRecord> {
        let mut ledger = self.runtime_window_zoom_receipts.lock().map_err(|_| {
            CoreError::Internal("runtime-window zoom receipt ledger poisoned".to_owned())
        })?;
        ledger.order.push_back(operation_id.clone());
        ledger.entries.insert(
            operation_id,
            RuntimeWindowZoomReceiptEntry {
                fingerprint,
                receipt: receipt.clone(),
            },
        );
        while ledger.order.len() > RETAINED_RUNTIME_WINDOW_ZOOM_RECEIPTS {
            if let Some(expired) = ledger.order.pop_front() {
                ledger.entries.remove(&expired);
            }
        }
        Ok(receipt)
    }

    fn runtime_window_zoom_terminal(
        &self,
        terminal: RuntimeWindowZoomTerminal<'_>,
    ) -> CoreResult<crate::model::RuntimeWindowZoomReceiptRecord> {
        self.retain_runtime_window_zoom_receipt(
            terminal.operation_id.clone(),
            terminal.fingerprint,
            crate::model::RuntimeWindowZoomReceiptRecord {
                operation_id: terminal.operation_id,
                window_id: terminal.window_id,
                window_generation: terminal.window_generation,
                source_topology_revision: terminal.source_topology_revision,
                topology_revision: terminal.topology_revision,
                action: terminal.action,
                previous_zoom_factor: terminal.previous_zoom_factor,
                next_zoom_factor: terminal.next_zoom_factor,
                status: terminal.status.to_owned(),
                role_surface_count: terminal
                    .counts
                    .map_or(0, |receipt| receipt.role_surface_count),
                global_web_surface_count: terminal
                    .counts
                    .map_or(0, |receipt| receipt.global_web_surface_count),
                popup_surface_count: terminal
                    .counts
                    .map_or(0, |receipt| receipt.popup_surface_count),
                failure_code: terminal.failure_code,
            },
        )
    }

    fn apply_runtime_window_zoom_action(
        &self,
        operation_id: String,
        window_id: String,
        window_generation: u64,
        topology_revision: u64,
        action: String,
    ) -> CoreResult<crate::model::RuntimeWindowZoomReceiptRecord> {
        self.validate_runtime_ui_action_identity(&operation_id, &[&window_id])?;
        if !matches!(action.as_str(), "in" | "out" | "reset") {
            return Err(runtime_window_zoom_error(
                "RUNTIME_WINDOW_ZOOM_ACTION_INVALID",
                "The runtime-window zoom action is invalid.",
            ));
        }
        let fingerprint = format!(
            "{window_id}:{window_generation}:{topology_revision}:{action}"
        );
        let _lane = self.embedded_runtime_sequence.acquire()?;
        if let Some(receipt) =
            self.cached_runtime_window_zoom_receipt(&operation_id, &fingerprint)?
        {
            return Ok(receipt);
        }
        let registration = self.browser_runtime_registration()?;
        let expected_platform = match self.platform {
            rion_platform::Platform::Macos => "macos",
            rion_platform::Platform::Windows => "windows",
        };
        if self.runtime_contract_version < CHROMIUM_RUNTIME_CONTRACT_VERSION
            || !registration.available
            || registration.platform != expected_platform
            || registration.engine != crate::model::ResolvedBrowserEngine::Chromium
        {
            return Err(runtime_window_zoom_error(
                "RUNTIME_WINDOW_ZOOM_UNAVAILABLE",
                "The registered Chromium runtime cannot apply runtime-window zoom.",
            ));
        }
        let before = self.browser_runtime.snapshot()?;
        let Some(window) = before.windows.get(&window_id).cloned() else {
            return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                operation_id,
                fingerprint,
                window_id,
                window_generation,
                source_topology_revision: topology_revision,
                topology_revision,
                action,
                previous_zoom_factor: DEFAULT_RUNTIME_WINDOW_ZOOM_FACTOR,
                next_zoom_factor: DEFAULT_RUNTIME_WINDOW_ZOOM_FACTOR,
                status: "superseded",
                counts: None,
                failure_code: Some("RUNTIME_WINDOW_ZOOM_STALE".to_owned()),
            });
        };
        let previous_zoom_factor = window
            .window_zoom_factor
            .unwrap_or(DEFAULT_RUNTIME_WINDOW_ZOOM_FACTOR);
        let next_zoom_factor = runtime_window_zoom_factor(previous_zoom_factor, &action);
        if window.window_generation != window_generation || window.revision != topology_revision {
            return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                operation_id,
                fingerprint,
                window_id,
                window_generation,
                source_topology_revision: topology_revision,
                topology_revision: window.revision,
                action,
                previous_zoom_factor,
                next_zoom_factor,
                status: "superseded",
                counts: None,
                failure_code: Some("RUNTIME_WINDOW_ZOOM_STALE".to_owned()),
            });
        }

        let native = self.execute_runtime_window_zoom_native(
            &operation_id,
            &window_id,
            window_generation,
            topology_revision,
            previous_zoom_factor,
            next_zoom_factor,
        );
        let native_receipt = match native {
            Ok(receipt) => receipt,
            Err(error) => {
                if matches!(
                    error.code(),
                    "RUNTIME_WINDOW_ZOOM_NATIVE_RECEIPT_MISSING"
                        | "RUNTIME_WINDOW_ZOOM_NATIVE_RECEIPT_INVALID"
                        | "RUNTIME_WINDOW_ZOOM_NATIVE_RECEIPT_STALE"
                ) {
                    let compensation = self.execute_runtime_window_zoom_native(
                        &operation_id,
                        &window_id,
                        window_generation,
                        topology_revision,
                        next_zoom_factor,
                        previous_zoom_factor,
                    );
                    let status = if compensation.is_ok() {
                        "failed"
                    } else {
                        "indeterminate"
                    };
                    let failure_code = compensation
                        .err()
                        .map(|reverse| reverse.code().to_owned())
                        .unwrap_or_else(|| error.code().to_owned());
                    return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                        operation_id,
                        fingerprint,
                        window_id,
                        window_generation,
                        source_topology_revision: topology_revision,
                        topology_revision,
                        action,
                        previous_zoom_factor,
                        next_zoom_factor,
                        status,
                        counts: None,
                        failure_code: Some(failure_code),
                    });
                }
                let status = if runtime_window_zoom_failure_is_indeterminate(&error) {
                    "indeterminate"
                } else {
                    "failed"
                };
                return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                    operation_id,
                    fingerprint,
                    window_id,
                    window_generation,
                    source_topology_revision: topology_revision,
                    topology_revision,
                    action,
                    previous_zoom_factor,
                    next_zoom_factor,
                    status,
                    counts: None,
                    failure_code: Some(error.code().to_owned()),
                });
            }
        };

        let commit = self.apply_runtime_intent(crate::RuntimeIntent::SetWindowZoomFactor {
            expected_revision: Some(topology_revision),
            operation_id: format!("{operation_id}:commit"),
            window_id: window_id.clone(),
            zoom_factor: next_zoom_factor,
        });
        let commit = match commit {
            Ok(commit) => commit,
            Err(error) => {
                let reverse = self.execute_runtime_window_zoom_native(
                    &operation_id,
                    &window_id,
                    window_generation,
                    topology_revision,
                    next_zoom_factor,
                    previous_zoom_factor,
                );
                let (status, failure_code) = match reverse {
                    Ok(_) => ("failed", error.code().to_owned()),
                    Err(reverse_error) => ("indeterminate", reverse_error.code().to_owned()),
                };
                return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                    operation_id,
                    fingerprint,
                    window_id,
                    window_generation,
                    source_topology_revision: topology_revision,
                    topology_revision,
                    action,
                    previous_zoom_factor,
                    next_zoom_factor,
                    status,
                    counts: Some(&native_receipt),
                    failure_code: Some(failure_code),
                });
            }
        };

        if commit.status != crate::RuntimeCommitStatus::Applied {
            let commit_failure_code = if commit.status == crate::RuntimeCommitStatus::Duplicate {
                "RUNTIME_WINDOW_ZOOM_COMMIT_DUPLICATE"
            } else {
                "RUNTIME_WINDOW_ZOOM_COMMIT_STALE"
            };
            let current = self
                .browser_runtime
                .snapshot()?
                .windows
                .get(&window_id)
                .cloned();
            let Some(current) = current else {
                return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                    operation_id,
                    fingerprint,
                    window_id,
                    window_generation,
                    source_topology_revision: topology_revision,
                    topology_revision: commit.revision,
                    action,
                    previous_zoom_factor,
                    next_zoom_factor,
                    status: "indeterminate",
                    counts: Some(&native_receipt),
                    failure_code: Some(
                        "RUNTIME_WINDOW_ZOOM_COMPENSATION_STATE_MISSING".to_owned(),
                    ),
                });
            };
            let current_zoom_factor = current
                .window_zoom_factor
                .unwrap_or(DEFAULT_RUNTIME_WINDOW_ZOOM_FACTOR);
            if self
                .project_embedded_runtime_snapshot_without_persistence(Some(&operation_id))
                .is_err()
            {
                return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                    operation_id,
                    fingerprint,
                    window_id,
                    window_generation,
                    source_topology_revision: topology_revision,
                    topology_revision: current.revision,
                    action,
                    previous_zoom_factor,
                    next_zoom_factor,
                    status: "indeterminate",
                    counts: Some(&native_receipt),
                    failure_code: Some(
                        "RUNTIME_WINDOW_ZOOM_COMPENSATION_PROJECTION_FAILED".to_owned(),
                    ),
                });
            }
            let reverse = self.execute_runtime_window_zoom_native(
                &operation_id,
                &window_id,
                current.window_generation,
                current.revision,
                next_zoom_factor,
                current_zoom_factor,
            );
            let status = if reverse.is_ok() {
                "superseded"
            } else {
                "indeterminate"
            };
            let failure_code = reverse
                .err()
                .map(|error| error.code().to_owned())
                .or_else(|| Some(commit_failure_code.to_owned()));
            return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                operation_id,
                fingerprint,
                window_id,
                window_generation,
                source_topology_revision: topology_revision,
                topology_revision: current.revision,
                action,
                previous_zoom_factor,
                next_zoom_factor,
                status,
                counts: Some(&native_receipt),
                failure_code,
            });
        }

        let after_commit = self.browser_runtime.snapshot();
        let after_commit = match after_commit {
            Ok(snapshot) => snapshot.windows.get(&window_id).cloned(),
            Err(error) => {
                return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                    operation_id,
                    fingerprint,
                    window_id,
                    window_generation,
                    source_topology_revision: topology_revision,
                    topology_revision,
                    action,
                    previous_zoom_factor,
                    next_zoom_factor,
                    status: "indeterminate",
                    counts: Some(&native_receipt),
                    failure_code: Some(error.code().to_owned()),
                });
            }
        };
        let Some(after_commit) = after_commit else {
            return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                operation_id,
                fingerprint,
                window_id,
                window_generation,
                source_topology_revision: topology_revision,
                topology_revision,
                action,
                previous_zoom_factor,
                next_zoom_factor,
                status: "indeterminate",
                counts: Some(&native_receipt),
                failure_code: Some("RUNTIME_WINDOW_ZOOM_COMMIT_STATE_MISSING".to_owned()),
            });
        };
        let committed_zoom_factor = after_commit
            .window_zoom_factor
            .unwrap_or(DEFAULT_RUNTIME_WINDOW_ZOOM_FACTOR);
        if after_commit.window_generation != window_generation
            || committed_zoom_factor != next_zoom_factor
        {
            return self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
                operation_id,
                fingerprint,
                window_id,
                window_generation,
                source_topology_revision: topology_revision,
                topology_revision: after_commit.revision,
                action,
                previous_zoom_factor,
                next_zoom_factor,
                status: "indeterminate",
                counts: Some(&native_receipt),
                failure_code: Some("RUNTIME_WINDOW_ZOOM_COMMIT_READBACK_STALE".to_owned()),
            });
        }

        let projected =
            self.project_embedded_runtime_snapshot_without_persistence(Some(&operation_id));
        let (status, failure_code) = match projected {
            Ok(_) => ("applied", None),
            Err(error) => ("indeterminate", Some(error.code().to_owned())),
        };
        self.runtime_window_zoom_terminal(RuntimeWindowZoomTerminal {
            operation_id,
            fingerprint,
            window_id,
            window_generation,
            source_topology_revision: topology_revision,
            topology_revision: after_commit.revision,
            action,
            previous_zoom_factor,
            next_zoom_factor,
            status,
            counts: Some(&native_receipt),
            failure_code,
        })
    }
}

impl AppCore {
    fn workspace_slot_is_current(
        &self,
        record: &crate::model::WorkspaceSlotLoadRecord,
    ) -> CoreResult<bool> {
        let snapshot = self.browser_runtime.snapshot()?;
        let Some(window) = snapshot.windows.get(&record.window_id) else {
            return Ok(false);
        };
        let Some(tab) = snapshot
            .browser_runtime
            .tabs
            .iter()
            .find(|tab| tab.id == record.tab_id)
        else {
            return Ok(false);
        };
        if window.window_generation != record.window_generation
            || !window.contains_tab(&record.tab_id)
            || tab.window_id != record.window_id
            || tab.tab_type != "workspace"
            || tab.attempt_generation.as_deref() != Some(record.attempt_generation.as_str())
        {
            return Ok(false);
        }
        Ok(tab.slots.iter().any(|slot| {
            slot.slot_id == record.slot_id
                && slot.role_id == record.surface_id
                && slot.owner.as_ref().is_some_and(|owner| {
                    owner.tab_id == record.tab_id && owner.generation == record.owner_generation
                })
        }) || (record.owner_generation == 0
            && tab.web_surfaces.iter().any(|surface| {
                surface.slot_id == record.slot_id && surface.surface_id == record.surface_id
            })))
    }

    fn report_workspace_slot_load(
        &self,
        mut record: crate::model::WorkspaceSlotLoadRecord,
    ) -> CoreResult<Option<crate::model::WorkspaceSlotLoadRecord>> {
        let _lane = self.embedded_runtime_sequence.acquire()?;
        if !self.workspace_slot_is_current(&record)? {
            return Ok(None);
        }
        if !matches!(record.phase.as_str(), "loading" | "ready" | "failed")
            || record.load_id.is_empty()
        {
            return Err(CoreError::InvalidInput(
                "Invalid workspace slot load event.".to_owned(),
            ));
        }
        let mut loads = self
            .workspace_slot_loads
            .lock()
            .map_err(|_| CoreError::Internal("slot load state poisoned".to_owned()))?;
        let snapshot = self.browser_runtime.snapshot()?;
        loads.retain(|(tab_id, _), state| {
            snapshot.browser_runtime.tabs.iter().any(|tab| {
                tab.id == *tab_id
                    && tab.attempt_generation.as_deref() == Some(state.attempt_generation.as_str())
            })
        });
        let key = (record.tab_id.clone(), record.slot_id.clone());
        if let Some(current) = loads.get(&key) {
            if current.load_id != record.load_id
                || current.revision != record.revision
                || current.phase != "loading"
                || current.owner_generation != record.owner_generation
                || (current.surface_generation > 0
                    && current.surface_generation != record.surface_generation)
            {
                return Ok(None);
            }
            record.revision = current.revision + 1;
        } else {
            if record.phase != "loading"
                || record.load_id != record.attempt_generation
                || record.revision != 0
            {
                return Ok(None);
            }
            record.revision = 1;
        }
        let language = self
            .overlay_language
            .lock()
            .map_err(|_| CoreError::Internal("language state poisoned".to_owned()))?;
        let labels = match language.as_deref().unwrap_or("en") {
            "zh-TW" => ("載入中", "此區塊載入失敗", "重試"),
            "zh-CN" => ("加载中", "此区块加载失败", "重试"),
            "ja" => (
                "読み込み中",
                "このセクションを読み込めませんでした",
                "再試行",
            ),
            _ => ("Loading", "Unable to load this section", "Retry"),
        };
        record.loading_label = Some(labels.0.to_owned());
        record.failure_label = Some(labels.1.to_owned());
        record.retry_label = Some(labels.2.to_owned());
        record.retryable &= record.phase == "failed";
        loads.insert(key, record.clone());
        drop(loads);
        if record.owner_generation > 0 && record.phase == "ready" {
            self.invoke_browser_runtime(BrowserRuntimeCommand::RoleTransition {
                role_id: record.surface_id.clone(),
                runtime: "embedded".to_owned(),
                tab_id: record.tab_id.clone(),
                slot_id: Some(record.slot_id.clone()),
                state: "running".to_owned(),
                launched_at: Some(chrono::Utc::now().to_rfc3339()),
            })?;
            self.browser_runtime_ready_roles
                .write()
                .map_err(|_| CoreError::Internal("ready roles poisoned".to_owned()))?
                .insert(record.surface_id.clone());
            self.browser_runtime_issues
                .write()
                .map_err(|_| CoreError::Internal("role issues poisoned".to_owned()))?
                .remove(&record.surface_id);
            self.macro_runtime
                .allow_role_after_launch(&record.surface_id);
        } else if record.owner_generation > 0 && record.phase == "failed" {
            self.browser_runtime_issues
                .write()
                .map_err(|_| CoreError::Internal("role issues poisoned".to_owned()))?
                .insert(
                    record.surface_id.clone(),
                    crate::model::BrowserRuntimeFailureReason::RuntimeCreationFailed,
                );
        }
        let snapshot = self.browser_runtime.snapshot()?;
        if let Some(activation) = snapshot.tab_activations.get(&record.tab_id) {
            use crate::model::RuntimeTabActivationPhaseRecord as Phase;
            if matches!(activation.phase, Phase::Ready | Phase::Degraded) {
                let loads = self
                    .workspace_slot_loads
                    .lock()
                    .map_err(|_| CoreError::Internal("slot load state poisoned".to_owned()))?;
                let failed = loads
                    .values()
                    .any(|slot| slot.tab_id == record.tab_id && slot.phase == "failed");
                let pending = loads
                    .values()
                    .any(|slot| slot.tab_id == record.tab_id && slot.phase == "loading");
                drop(loads);
                if !pending {
                    self.apply_runtime_intent(crate::RuntimeIntent::SetTabActivationPhase {
                        activation_attempt_id: activation.attempt_id.clone(),
                        operation_id: format!("slot-load:{}:{}", record.load_id, record.revision),
                        phase: if failed {
                            Phase::Degraded
                        } else {
                            Phase::Ready
                        },
                        tab_id: crate::RuntimeTabId::new(record.tab_id.clone())
                            .map_err(CoreError::InvalidInput)?,
                    })?;
                }
            }
        }
        Ok(Some(record))
    }

    fn retry_workspace_slot(
        &self,
        record: crate::model::WorkspaceSlotLoadRecord,
    ) -> CoreResult<bool> {
        let next = {
            let _lane = self.embedded_runtime_sequence.acquire()?;
            if !self.workspace_slot_is_current(&record)? {
                return Ok(false);
            }
            let mut loads = self
                .workspace_slot_loads
                .lock()
                .map_err(|_| CoreError::Internal("slot load state poisoned".to_owned()))?;
            let key = (record.tab_id.clone(), record.slot_id.clone());
            let current = loads.get(&key).cloned().map(|mut current| {
                // Topology is validated above. A committed move preserves this slot load.
                current.window_id = record.window_id.clone();
                current.window_generation = record.window_generation;
                current
            });
            if current.as_ref() != Some(&record) || record.phase != "failed" || !record.retryable {
                return Ok(false);
            }
            let mut next = record.clone();
            next.load_id = uuid::Uuid::new_v4().to_string();
            next.phase = "loading".to_owned();
            next.retryable = false;
            next.surface_generation = 0;
            next.revision += 1;
            loads.insert(key, next.clone());
            next
        };
        self.run_effect_plan(vec![effect_step(
            &record.tab_id,
            CoreEffectAction::EmbeddedRetryWorkspaceSlot { record: next },
            Duration::from_secs(45),
            None,
        )])?;
        Ok(true)
    }

    fn workspace_ready_role_ids(
        &self,
        tab_id: &str,
        role_ids: Vec<String>,
    ) -> CoreResult<Vec<String>> {
        let loads = self
            .workspace_slot_loads
            .lock()
            .map_err(|_| CoreError::Internal("slot load state poisoned".to_owned()))?;
        Ok(role_ids
            .into_iter()
            .filter(|role_id| {
                !loads.values().any(|state| {
                    state.tab_id == tab_id && state.surface_id == *role_id && state.phase != "ready"
                })
            })
            .collect())
    }
}

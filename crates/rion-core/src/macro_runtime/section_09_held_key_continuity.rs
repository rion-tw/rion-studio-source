pub(crate) struct HeldKeyContinuityDispatch<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) role_id: &'a str,
    pub(crate) surface_generation: u64,
    pub(crate) document_instance_id: &'a str,
    pub(crate) loss_reason: &'a str,
    pub(crate) loss_revision: u64,
}

pub(crate) struct HeldKeyContinuityDispatchResult {
    pub(crate) error_code: Option<String>,
    pub(crate) error_message: Option<String>,
    pub(crate) input_epoch: u64,
    pub(crate) request_ids: Vec<String>,
    pub(crate) reasserted_key_count: usize,
    pub(crate) status: &'static str,
}

impl MacroRuntime {
    pub(crate) fn reassert_held_keys_after_context_loss(
        &self,
        dispatch: HeldKeyContinuityDispatch<'_>,
    ) -> CoreResult<HeldKeyContinuityDispatchResult> {
        let input_sequence = input_sequence_role_lock(&self.shared, dispatch.role_id)
            .map_err(CoreError::Internal)?;
        let _input_sequence_guard = input_sequence
            .lock()
            .map_err(|_| CoreError::Internal("macro input sequence lock poisoned".to_owned()))?;
        let (input_epoch, mut held_keys) = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| CoreError::Internal("macro runtime lock poisoned".to_owned()))?;
            let revision_key = (
                dispatch.role_id.to_owned(),
                dispatch.loss_reason.to_owned(),
            );
            let prior_revision = inner
                .held_key_continuity_revisions
                .get(&revision_key);
            if prior_revision.is_some_and(|prior| {
                prior.surface_generation == dispatch.surface_generation
                    && prior.document_instance_id == dispatch.document_instance_id
                    && dispatch.loss_revision <= prior.loss_revision
            }) {
                return Ok(HeldKeyContinuityDispatchResult {
                    error_code: None,
                    error_message: None,
                    input_epoch: inner
                        .input_epochs
                        .get(dispatch.role_id)
                        .copied()
                        .unwrap_or_default(),
                    request_ids: Vec::new(),
                    reasserted_key_count: 0,
                    status: "superseded",
                });
            }
            inner
                .held_key_continuity_revisions
                .insert(
                    revision_key,
                    HeldKeyContinuityRevision {
                        document_instance_id: dispatch.document_instance_id.to_owned(),
                        loss_revision: dispatch.loss_revision,
                        surface_generation: dispatch.surface_generation,
                    },
                );
            let input_epoch = inner
                .input_epochs
                .get(dispatch.role_id)
                .copied()
                .unwrap_or_default();
            let held_keys = inner
                .held_keys
                .values()
                .filter(|held| held.role_id == dispatch.role_id)
                .cloned()
                .collect::<Vec<_>>();
            (input_epoch, held_keys)
        };
        held_keys.sort_by(|left, right| left.owner_id.cmp(&right.owner_id));
        if held_keys.is_empty() {
            return Ok(HeldKeyContinuityDispatchResult {
                error_code: None,
                error_message: None,
                input_epoch,
                request_ids: Vec::new(),
                reasserted_key_count: 0,
                status: "noHeldKeys",
            });
        }
        let control = new_invocation_control(
            format!("held-continuity:{}", dispatch.operation_id),
            format!("held-continuity:{}", dispatch.loss_revision),
            HashSet::from([dispatch.role_id.to_owned()]),
        );
        let exact_surface = ExactBrowserActionSurface {
            role_id: dispatch.role_id.to_owned(),
            surface_generation: dispatch.surface_generation,
            document_instance_id: dispatch.document_instance_id.to_owned(),
        };
        let actions = held_keys
            .iter()
            .map(|held| {
                (
                    dispatch.role_id,
                    BrowserAction::Key {
                        phase: "hold".to_owned(),
                        key: held.code.clone(),
                        code: Some(held.code.clone()),
                        modifiers: held.modifiers.clone(),
                        owner_id: held.owner_id.clone(),
                        suppress_overlay_shortcut: true,
                    },
                )
            })
            .collect::<Vec<_>>();
        match perform_actions_with_control(
            &self.shared,
            &control,
            actions,
            false,
            Some(&exact_surface),
        ) {
            Ok(request_ids) => Ok(HeldKeyContinuityDispatchResult {
                error_code: None,
                error_message: None,
                input_epoch,
                reasserted_key_count: request_ids.len(),
                request_ids,
                status: "reasserted",
            }),
            Err(failure) => {
                let indeterminate = failure.cause_code == "SYSTEM_TRUSTED_INPUT_INDETERMINATE";
                Ok(HeldKeyContinuityDispatchResult {
                    error_code: Some(failure.cause_code),
                    error_message: Some(failure.message),
                    input_epoch,
                    request_ids: failure
                        .request_id
                        .into_iter()
                        .chain(failure.focus_request_ids)
                        .collect(),
                    reasserted_key_count: 0,
                    status: if indeterminate { "indeterminate" } else { "failed" },
                })
            }
        }
    }
}

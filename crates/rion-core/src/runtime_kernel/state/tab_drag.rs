use super::*;
use crate::model::{RuntimeTabDragEventRecord as Event, RuntimeTabDragReceiptRecord as Receipt};

#[derive(Clone, Default)]
pub(super) struct DragState {
    active: Option<(Event, Receipt)>,
    retired: VecDeque<String>,
}

impl DragState {
    pub(super) fn transfers_tab(&self, tab_id: &str) -> bool {
        self.active
            .as_ref()
            .is_some_and(|(event, receipt)| event.tab_id == tab_id && !receipt.terminal)
    }
}

fn retire(state: &mut DragState, id: String) {
    state.retired.push_back(id);
    if state.retired.len() > 512 {
        state.retired.pop_front();
    }
}

pub(super) fn apply(
    state: &mut RuntimeKernelState,
    event: Event,
    epoch: u64,
) -> CoreResult<Receipt> {
    if event.session_id.is_empty()
        || event.session_id.len() > 256
        || event.sequence == 0
        || !matches!(
            event.phase.as_str(),
            "start" | "sample" | "bindFloating" | "end" | "cancel" | "fail"
        )
    {
        return Err(CoreError::InvalidInput(
            "invalid runtime tab drag event".into(),
        ));
    }
    let owner = state
        .windows
        .values()
        .find(|window| window.contains_tab(&event.tab_id));
    let mut receipt = Receipt {
        session_id: event.session_id.clone(),
        sequence: event.sequence,
        status: "superseded".into(),
        terminal: true,
        single_tab: false,
        current_window_id: owner.map(|window| window.window_id.clone()),
        floating_window_id: None,
    };
    if state.drag.retired.contains(&event.session_id) {
        return Ok(receipt);
    }
    if event.phase == "start" {
        if event.lifecycle_epoch != epoch
            || event.sequence != 1
            || owner.is_none_or(|window| {
                window.window_id != event.source_window_id
                    || window.window_generation != event.source_window_generation
            })
        {
            return Ok(receipt);
        }
        if state
            .drag
            .active
            .as_ref()
            .is_some_and(|(active, _)| active.session_id == event.session_id)
        {
            return Ok(receipt);
        }
        receipt.single_tab = owner.is_some_and(|window| window.tabs.len() == 1);
        if receipt.single_tab {
            receipt.floating_window_id = Some(event.source_window_id.clone());
        }
        if let Some((previous, _)) = state.drag.active.take() {
            retire(&mut state.drag, previous.session_id);
        }
    } else {
        let Some((active, previous)) = state.drag.active.as_ref() else {
            return Ok(receipt);
        };
        if active.session_id != event.session_id
            || active.tab_id != event.tab_id
            || active.source_window_id != event.source_window_id
            || active.source_window_generation != event.source_window_generation
            || active.lifecycle_epoch != event.lifecycle_epoch
            || event.sequence <= active.sequence
        {
            return Ok(receipt);
        }
        receipt.single_tab = previous.single_tab;
        receipt.floating_window_id = previous.floating_window_id.clone();
        if event.lifecycle_epoch != epoch
            || owner.is_none()
            || state
                .windows
                .get(&event.source_window_id)
                .is_none_or(|source| source.window_generation != event.source_window_generation)
        {
            state.drag.active = None;
            retire(&mut state.drag, event.session_id);
            return Ok(receipt);
        }
        if event.phase == "bindFloating" {
            let valid = event.floating_window_id.as_ref().is_some_and(|id| {
                previous
                    .floating_window_id
                    .as_ref()
                    .is_none_or(|prior| prior == id)
                    && state.windows.get(id).is_some_and(|window| {
                        window.tabs.is_empty() || window.contains_tab(&event.tab_id)
                    })
            });
            if !valid {
                return Err(CoreError::InvalidInput("invalid floating drag host".into()));
            }
            receipt.floating_window_id = event.floating_window_id.clone();
        }
    }
    receipt.terminal = matches!(event.phase.as_str(), "end" | "cancel" | "fail");
    receipt.status = match event.phase.as_str() {
        "cancel" => "cancelled",
        "fail" => "indeterminate",
        _ => "applied",
    }
    .into();
    if receipt.terminal {
        state.drag.active = None;
        retire(&mut state.drag, event.session_id);
    } else {
        state.drag.active = Some((event, receipt.clone()));
    }
    Ok(receipt)
}

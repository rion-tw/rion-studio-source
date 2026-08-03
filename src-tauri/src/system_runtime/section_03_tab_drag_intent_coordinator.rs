const TAB_DRAG_INTENT_HISTORY_LIMIT: usize = 256;

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct NativeTabDragActionStamp {
    pub(crate) event_sequence: u64,
    pub(crate) intent_generation: u64,
}

#[derive(Clone, Debug)]
struct NativeTabDragIntent {
    completed: bool,
    generation: u64,
    #[cfg(any(target_os = "macos", test))]
    last_event_sequence: u64,
    operation_id: Option<String>,
    source_window_id: String,
    tab_id: String,
    target_window_id: Option<String>,
}

#[derive(Default)]
struct TabDragIntentState {
    latest_by_window: HashMap<String, u64>,
    order: VecDeque<String>,
    sessions: HashMap<String, NativeTabDragIntent>,
    latest_by_tab: HashMap<String, u64>,
    operations: HashMap<String, String>,
}

#[derive(Default)]
pub(crate) struct TabDragIntentCoordinator {
    #[cfg(any(target_os = "macos", test))]
    event_sequence: AtomicU64,
    #[cfg(any(target_os = "macos", test))]
    intent_generation: AtomicU64,
    state: Mutex<TabDragIntentState>,
}

impl TabDragIntentCoordinator {
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn stamp_action(
        &self,
        action_type: &str,
        session_id: Option<&str>,
        tab_id: Option<&str>,
        source_window_id: Option<&str>,
        target_window_id: Option<&str>,
    ) -> NativeTabDragActionStamp {
        let event_sequence = self.event_sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let Some(session_id) = session_id else {
            return NativeTabDragActionStamp {
                event_sequence,
                intent_generation: 0,
            };
        };
        let Ok(mut state) = self.state.lock() else {
            return NativeTabDragActionStamp {
                event_sequence,
                intent_generation: 0,
            };
        };
        if action_type == "tabDragStart" {
            let Some(tab_id) = tab_id.filter(|value| !value.is_empty()) else {
                return NativeTabDragActionStamp {
                    event_sequence,
                    intent_generation: 0,
                };
            };
            if let Some(intent) = state.sessions.get_mut(session_id)
                && intent.tab_id == tab_id
            {
                intent.last_event_sequence = event_sequence;
                return NativeTabDragActionStamp {
                    event_sequence,
                    intent_generation: intent.generation,
                };
            }
            let generation = self.intent_generation.fetch_add(1, Ordering::AcqRel) + 1;
            state.latest_by_tab.insert(tab_id.to_owned(), generation);
            record_latest_window_generation(
                &mut state.latest_by_window,
                source_window_id.unwrap_or_default(),
                generation,
            );
            state.order.push_back(session_id.to_owned());
            state.sessions.insert(
                session_id.to_owned(),
                NativeTabDragIntent {
                    completed: false,
                    generation,
                    #[cfg(any(target_os = "macos", test))]
                    last_event_sequence: event_sequence,
                    operation_id: None,
                    source_window_id: source_window_id.unwrap_or_default().to_owned(),
                    tab_id: tab_id.to_owned(),
                    target_window_id: None,
                },
            );
            prune_tab_drag_intents(&mut state);
            return NativeTabDragActionStamp {
                event_sequence,
                intent_generation: generation,
            };
        }
        let Some(intent) = state.sessions.get_mut(session_id) else {
            return NativeTabDragActionStamp {
                event_sequence,
                intent_generation: 0,
            };
        };
        intent.last_event_sequence = event_sequence;
        let target_window_id = target_window_id
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if let Some(target_window_id) = target_window_id.as_deref() {
            intent.target_window_id = Some(target_window_id.to_owned());
        }
        let generation = intent.generation;
        if let Some(target_window_id) = target_window_id.as_deref() {
            record_latest_window_generation(
                &mut state.latest_by_window,
                target_window_id,
                generation,
            );
        }
        NativeTabDragActionStamp {
            event_sequence,
            intent_generation: generation,
        }
    }

    pub(crate) fn bind_operation(&self, session_id: &str, operation_id: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some(intent) = state.sessions.get_mut(session_id) {
            intent.operation_id = Some(operation_id.to_owned());
            state
                .operations
                .insert(operation_id.to_owned(), session_id.to_owned());
        }
    }

    pub(crate) fn is_latest(&self, session_id: &str, generation: u64) -> bool {
        self.state.lock().is_ok_and(|state| {
            let Some(intent) = state.sessions.get(session_id) else {
                return false;
            };
            intent.generation == generation
                && state.latest_by_tab.get(&intent.tab_id).copied() == Some(generation)
        })
    }

    pub(crate) fn projection_is_latest(&self, session_id: &str, generation: u64) -> bool {
        self.state.lock().is_ok_and(|state| {
            state.sessions.get(session_id).is_some_and(|intent| {
                intent.generation == generation && !tab_drag_intent_is_superseded(&state, intent)
            })
        })
    }

    pub(crate) fn operation_is_superseded(&self, operation_id: &str, tab_id: &str) -> bool {
        self.state.lock().is_ok_and(|state| {
            let Some(session_id) = state.operations.get(operation_id) else {
                return false;
            };
            let Some(intent) = state.sessions.get(session_id) else {
                return false;
            };
            intent.tab_id == tab_id && tab_drag_intent_is_superseded(&state, intent)
        })
    }

    pub(crate) fn newer_intent_started_in(
        &self,
        session_id: &str,
        generation: u64,
        window_id: &str,
    ) -> bool {
        self.state.lock().is_ok_and(|state| {
            let Some(intent) = state.sessions.get(session_id) else {
                return false;
            };
            if intent.generation != generation {
                return false;
            }
            let Some(latest_generation) = state.latest_by_tab.get(&intent.tab_id).copied() else {
                return false;
            };
            latest_generation > generation
                && state.sessions.values().any(|candidate| {
                    candidate.tab_id == intent.tab_id
                        && candidate.generation == latest_generation
                        && candidate.source_window_id == window_id
                })
        })
    }

    pub(crate) fn projection_is_superseded(
        &self,
        parent_operation_id: Option<&str>,
        window_id: &str,
    ) -> bool {
        self.state.lock().is_ok_and(|state| {
            if let Some(parent_operation_id) = parent_operation_id
                && let Some(session_id) = state.operations.get(parent_operation_id)
                && let Some(intent) = state.sessions.get(session_id)
            {
                return tab_drag_intent_is_superseded(&state, intent);
            }
            state.sessions.values().any(|intent| {
                !intent.completed
                    && (intent.source_window_id == window_id
                        || intent.target_window_id.as_deref() == Some(window_id))
                    && state.latest_by_tab.get(&intent.tab_id).copied() == Some(intent.generation)
            })
        })
    }

    pub(crate) fn complete(&self, session_id: &str) {
        if let Ok(mut state) = self.state.lock()
            && let Some(intent) = state.sessions.get_mut(session_id)
        {
            intent.completed = true;
            prune_tab_drag_intents(&mut state);
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn record_latest_window_generation(
    latest_by_window: &mut HashMap<String, u64>,
    window_id: &str,
    generation: u64,
) {
    if window_id.is_empty() {
        return;
    }
    latest_by_window
        .entry(window_id.to_owned())
        .and_modify(|latest| *latest = (*latest).max(generation))
        .or_insert(generation);
}

fn tab_drag_intent_is_superseded(state: &TabDragIntentState, intent: &NativeTabDragIntent) -> bool {
    state
        .latest_by_tab
        .get(&intent.tab_id)
        .is_some_and(|latest| *latest > intent.generation)
        || state
            .latest_by_window
            .get(&intent.source_window_id)
            .is_some_and(|latest| *latest > intent.generation)
        || intent.target_window_id.as_deref().is_some_and(|window_id| {
            state
                .latest_by_window
                .get(window_id)
                .is_some_and(|latest| *latest > intent.generation)
        })
}

fn prune_tab_drag_intents(state: &mut TabDragIntentState) {
    let mut scanned = 0;
    while state.order.len() > TAB_DRAG_INTENT_HISTORY_LIMIT && scanned < state.order.len() {
        let Some(session_id) = state.order.pop_front() else {
            break;
        };
        let removable = state
            .sessions
            .get(&session_id)
            .is_some_and(|intent| intent.completed);
        if !removable {
            state.order.push_back(session_id);
            scanned += 1;
            continue;
        }
        if let Some(intent) = state.sessions.remove(&session_id)
            && let Some(operation_id) = intent.operation_id
        {
            state.operations.remove(&operation_id);
        }
    }
}

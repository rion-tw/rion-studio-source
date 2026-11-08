// Device-local window memory: the main window's frame and, per launch source,
// the last placement and zoom of the transient Game Window that hosted it.
// Native placement and zoom commits are the only writers; nothing polls.
const WINDOW_MEMORY_SOURCE_LIMIT: usize = 64;
const WINDOW_MEMORY_MAX_COORDINATE: i32 = 1_000_000;

fn window_memory_bounds_valid(bounds: &crate::model::StatePixelBoundsRecord) -> bool {
    bounds.width >= 200
        && bounds.height >= 150
        && bounds.width <= WINDOW_MEMORY_MAX_COORDINATE
        && bounds.height <= WINDOW_MEMORY_MAX_COORDINATE
        && bounds.x.abs() <= WINDOW_MEMORY_MAX_COORDINATE
        && bounds.y.abs() <= WINDOW_MEMORY_MAX_COORDINATE
}

fn window_memory_source_key_valid(key: &str) -> bool {
    let Some((kind, id)) = key.split_once(':') else {
        return false;
    };
    matches!(kind, "role" | "workspace" | "window")
        && !id.is_empty()
        && id.len() <= 128
        && id.trim() == id
}

fn normalize_window_memory(
    mut memory: crate::model::WindowMemoryRecord,
) -> crate::model::WindowMemoryRecord {
    if memory
        .main_window
        .as_ref()
        .is_some_and(|main| !window_memory_bounds_valid(&main.bounds))
    {
        memory.main_window = None;
    }
    let mut seen = std::collections::HashSet::new();
    memory.sources.retain(|source| {
        window_memory_source_key_valid(&source.key)
            && seen.insert(source.key.clone())
            && source.window_zoom_factor.is_finite()
            && (0.25..=5.0).contains(&source.window_zoom_factor)
            && source.placement.as_ref().is_none_or(|placement| {
                window_memory_bounds_valid(&placement.normal_bounds)
                    && matches!(
                        placement.presentation.as_str(),
                        "normal" | "maximized" | "fullscreen"
                    )
            })
    });
    memory.sources.truncate(WINDOW_MEMORY_SOURCE_LIMIT);
    memory
}

/// Launch-source keys of the tabs a live window currently hosts.
fn window_memory_source_keys(window: &crate::RuntimeLiveWindowRecord) -> Vec<String> {
    let mut keys = Vec::new();
    for tab in &window.tabs {
        if !matches!(tab.tab_type.as_str(), "role" | "workspace") || tab.source_id.is_empty() {
            continue;
        }
        let key = format!("{}:{}", tab.tab_type, tab.source_id);
        if window_memory_source_key_valid(&key) && !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

impl AppCore {
    pub fn window_memory(&self) -> CoreResult<crate::model::WindowMemoryRecord> {
        Ok(normalize_window_memory(
            self.read_optional_scalar_state::<crate::model::WindowMemoryRecord>("windowMemory")?
                .unwrap_or_default(),
        ))
    }

    fn update_window_memory(
        &self,
        update: impl FnOnce(&mut crate::model::WindowMemoryRecord),
    ) -> CoreResult<crate::model::WindowMemoryRecord> {
        let _state_guard = self.state_mutation_guard()?;
        let before = normalize_window_memory(
            self.read_optional_scalar_state::<crate::model::WindowMemoryRecord>("windowMemory")?
                .unwrap_or_default(),
        );
        let mut memory = before.clone();
        update(&mut memory);
        let memory = normalize_window_memory(memory);
        if memory != before {
            self.replace_scalar_state_under_guard("windowMemory", memory.clone())?;
        }
        Ok(memory)
    }

    pub fn replace_main_window_memory(
        &self,
        record: crate::model::MainWindowMemoryRecord,
    ) -> CoreResult<crate::model::WindowMemoryRecord> {
        if !window_memory_bounds_valid(&record.bounds) {
            return Err(CoreError::InvalidInput(
                "main window memory bounds are invalid".to_owned(),
            ));
        }
        self.update_window_memory(|memory| memory.main_window = Some(record))
    }

    /// Records one source entry, keeping the newest entry first. An entry
    /// whose remembered values did not change keeps its timestamp and order.
    fn remember_window_source(
        memory: &mut crate::model::WindowMemoryRecord,
        key: String,
        apply: impl Fn(&mut crate::model::SourceWindowMemoryRecord),
    ) {
        let index = memory.sources.iter().position(|source| source.key == key);
        let mut entry = index
            .map(|index| memory.sources[index].clone())
            .unwrap_or_else(|| crate::model::SourceWindowMemoryRecord {
                key: key.clone(),
                target_display: None,
                placement: None,
                window_zoom_factor: 1.0,
                updated_at: String::new(),
            });
        let previous = entry.clone();
        apply(&mut entry);
        if index.is_some() && entry == previous {
            return;
        }
        entry.updated_at = chrono::Utc::now().to_rfc3339();
        if let Some(index) = index {
            memory.sources.remove(index);
        }
        memory.sources.insert(0, entry);
    }

    /// A transient window's acknowledged native placement becomes the
    /// remembered placement of every launch source it hosts.
    fn remember_transient_window_placement(
        &self,
        window: &crate::RuntimeLiveWindowRecord,
    ) -> CoreResult<()> {
        let (Some(placement), Some(target_display)) =
            (window.placement.clone(), window.target_display.clone())
        else {
            return Ok(());
        };
        let keys = window_memory_source_keys(window);
        if keys.is_empty() || !window_memory_bounds_valid(&placement.normal_bounds) {
            return Ok(());
        }
        let zoom = window.window_zoom_factor.unwrap_or(1.0);
        self.update_window_memory(|memory| {
            for key in keys {
                Self::remember_window_source(memory, key, |entry| {
                    entry.target_display = Some(target_display.clone());
                    entry.placement = Some(placement.clone());
                    entry.window_zoom_factor = zoom;
                });
            }
        })?;
        Ok(())
    }

    /// A committed window zoom is remembered for the saved window itself, or
    /// for the launch sources of a transient window.
    fn remember_window_zoom(&self, window_id: &str, zoom_factor: f64) -> CoreResult<()> {
        let snapshot = self.browser_runtime.snapshot()?;
        let Some(window) = snapshot.windows.get(window_id) else {
            return Ok(());
        };
        let saved = self
            .read_typed_state_collection::<StateGameWindowRecord>("gameWindows")?
            .iter()
            .any(|saved| saved.id == window_id);
        let keys = if saved {
            vec![format!("window:{window_id}")]
        } else {
            window_memory_source_keys(window)
        };
        if keys.is_empty() {
            return Ok(());
        }
        let placement = (!saved).then(|| window.placement.clone()).flatten();
        let target_display = (!saved).then(|| window.target_display.clone()).flatten();
        self.update_window_memory(|memory| {
            for key in keys {
                Self::remember_window_source(memory, key, |entry| {
                    entry.window_zoom_factor = zoom_factor;
                    if placement.is_some() && target_display.is_some() {
                        entry.placement = placement.clone();
                        entry.target_display = target_display.clone();
                    }
                });
            }
        })?;
        Ok(())
    }
}

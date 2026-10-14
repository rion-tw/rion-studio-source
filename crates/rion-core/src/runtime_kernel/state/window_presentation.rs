fn apply_window_presentation(
    state: &mut RuntimeKernelState,
    expected_revision: u64,
    presentation: String,
    window_generation: u64,
    window_id: String,
) -> CoreResult<RuntimeCommit> {
    if !matches!(presentation.as_str(), "normal" | "maximized" | "fullscreen") {
        return Err(CoreError::InvalidInput(
            "runtime window presentation is invalid".to_owned(),
        ));
    }
    let Some(current) = state.windows.get(&window_id) else {
        return Ok(superseded_commit(state, None, vec![window_id]));
    };
    if current.revision != expected_revision
        || current.window_generation != window_generation
        || current.placement.is_none()
    {
        return Ok(superseded_commit(state, None, vec![window_id]));
    }
    // This intent follows an exact native presentation acknowledgement. Its
    // fresh revision also fences durability when that acknowledgement repairs
    // an already-selected mode. Native placement sequences remain owned by the
    // adapter, so Core actions cannot consume a future move/resize event.
    let revision = next_revision(state);
    let window = state
        .windows
        .get_mut(&window_id)
        .expect("presentation candidate was validated");
    window
        .placement
        .as_mut()
        .expect("placement was validated")
        .presentation = presentation;
    window.revision = revision;
    Ok(basic_commit(state, false, vec![window_id]))
}

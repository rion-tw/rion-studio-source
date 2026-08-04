impl AppCore {
    fn invoke_embedded_tab_mutation_command(&self, command: CoreCommand) -> CoreResult<Value> {
        match command {
            CoreCommand::EmbeddedTabMutation {
                request,
                target,
                before_tab_id,
            } => self.serialized_embedded_tab_mutation(request, target, before_tab_id),
            CoreCommand::EmbeddedTabDragTopologyCommit {
                request,
                target,
                source_before_tab_ids,
                source_after_tab_ids,
                target_before_tab_ids,
                target_after_tab_ids,
            } => self.serialized_embedded_tab_drag_topology_commit(
                request,
                target,
                source_before_tab_ids,
                source_after_tab_ids,
                target_before_tab_ids,
                target_after_tab_ids,
            ),
            _ => unreachable!("only synchronous embedded tab mutation commands are dispatched here"),
        }
    }
}

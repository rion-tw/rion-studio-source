#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowCloseTransaction {
    context: NativeOperationContext,
    generation: Option<u64>,
    label: Option<String>,
    native_submitted: bool,
    window_id: String,
}
#[derive(Default)]
struct WindowCloseLedger {
    operation_by_label: HashMap<String, String>,
    operations: HashMap<String, WindowCloseTransaction>,
}

impl WindowCloseLedger {
    fn contains_window_generation(&self, window_id: &str, generation: u64) -> bool {
        self.operations.values().any(|transaction| {
            transaction.window_id == window_id && transaction.generation == Some(generation)
        })
    }

    fn operation_id_for_window(&self, window_id: &str) -> Option<String> {
        self.operations
            .iter()
            .find_map(|(operation_id, transaction)| {
                (transaction.window_id == window_id).then(|| operation_id.clone())
            })
    }

    fn pending_operation_id(&self, label: &str) -> Option<String> {
        self.operation_by_label.get(label).cloned()
    }

    fn insert(&mut self, transaction: WindowCloseTransaction) -> Result<(), &'static str> {
        let operation_id = transaction.context.operation_id.clone();
        if self.operations.contains_key(&operation_id) {
            return Err("SYSTEM_WINDOW_CLOSE_OPERATION_CONFLICT");
        }
        if let Some(label) = transaction.label.as_ref()
            && self.operation_by_label.contains_key(label)
        {
            return Err("SYSTEM_WINDOW_CLOSE_ALREADY_PENDING");
        }
        if let Some(label) = transaction.label.as_ref() {
            self.operation_by_label
                .insert(label.clone(), operation_id.clone());
        }
        self.operations.insert(operation_id, transaction);
        Ok(())
    }

    fn get(&self, operation_id: &str) -> Option<&WindowCloseTransaction> {
        self.operations.get(operation_id)
    }

    fn get_mut(&mut self, operation_id: &str) -> Option<&mut WindowCloseTransaction> {
        self.operations.get_mut(operation_id)
    }

    fn remove(&mut self, operation_id: &str) -> Option<WindowCloseTransaction> {
        let transaction = self.operations.remove(operation_id)?;
        if let Some(label) = transaction.label.as_ref()
            && self.operation_by_label.get(label).map(String::as_str) == Some(operation_id)
        {
            self.operation_by_label.remove(label);
        }
        Some(transaction)
    }

    fn take_destroyed(&mut self, label: &str) -> Option<WindowCloseTransaction> {
        let operation_id = self.operation_by_label.get(label)?.clone();
        self.remove(&operation_id)
    }

    fn drain(&mut self) -> Vec<WindowCloseTransaction> {
        self.operation_by_label.clear();
        std::mem::take(&mut self.operations).into_values().collect()
    }
}

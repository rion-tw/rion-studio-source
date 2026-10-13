fn assert_cancellation_wait_handoff<T>(
    control: &Arc<InvocationControl>,
    gate: &(Mutex<T>, Condvar),
) {
    // Pause a consumer after its predicate check but before Condvar::wait.
    let guard = gate.0.lock().unwrap();
    assert!(!control.cancelled.load(Ordering::Acquire));
    let wake = control.wake.0.lock().unwrap();
    let cancelling = Arc::clone(control);
    let (finished, completion) = mpsc::channel();
    let cancel = thread::spawn(move || {
        cancel_control(&cancelling);
        finished.send(()).unwrap();
    });
    let (wake, _) = control
        .wake
        .1
        .wait_timeout_while(wake, Duration::from_secs(2), |_| {
            !control.cancelled.load(Ordering::Acquire)
        })
        .unwrap();
    assert!(control.cancelled.load(Ordering::Acquire));
    drop(wake);
    // Cancellation has begun, but publishing its notification cannot bypass
    // this consumer's still-held handoff lock.
    assert_eq!(
        completion.recv_timeout(Duration::from_millis(20)),
        Err(mpsc::RecvTimeoutError::Timeout)
    );
    let (guard, observation) = gate
        .1
        .wait_timeout(guard, Duration::from_secs(2))
        .unwrap();
    assert!(!observation.timed_out(), "cancellation notification was lost");
    drop(guard);
    completion.recv_timeout(Duration::from_secs(2)).unwrap();
    cancel.join().unwrap();
}

#[test]
fn cancellation_wakes_the_start_gate_at_its_wait_handoff() {
    let control = new_invocation_control("start".into(), "macro".into(), HashSet::new());
    assert_cancellation_wait_handoff(&control, &control.start_ready);
}

#[test]
fn cancellation_wakes_the_first_iteration_gate_at_its_wait_handoff() {
    let control = new_invocation_control("iteration".into(), "macro".into(), HashSet::new());
    assert_cancellation_wait_handoff(&control, &control.first_iteration_roles);
}

#[test]
fn cancellation_wakes_the_child_gate_at_its_wait_handoff() {
    let control = new_invocation_control("children".into(), "macro".into(), HashSet::new());
    assert_cancellation_wait_handoff(&control, &control.children);
}

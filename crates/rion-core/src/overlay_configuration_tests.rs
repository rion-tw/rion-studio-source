use super::*;
use crate::model::StateCollection;

#[test]
fn configuration_event_bypasses_an_existing_presentation_coalescing_window() {
    let (core_sender, core_receiver) = bounded(8);
    let (control, control_receiver) = bounded(1);
    let (_invalidation, invalidation_receiver) = bounded(1);
    let (output_sender, output_receiver) = bounded(8);
    let events: EventSink = Arc::new(move |events| output_sender.send(events).unwrap());
    let worker = thread::spawn(move || {
        run_refresh_worker(
            core_receiver,
            control_receiver,
            invalidation_receiver,
            events,
            Duration::from_secs(60),
        );
    });
    // The first authoritative receipt establishes an active coalescing window.
    core_sender
        .send(vec![CoreEvent::MacroStatuses {
            reliable: true,
            statuses: vec![],
        }])
        .unwrap();
    output_receiver
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    core_sender
        .send(vec![
            CoreEvent::MacroStatuses {
                reliable: true,
                statuses: vec![],
            },
            CoreEvent::StateChanged {
                revision: 2,
                changed_collections: vec![StateCollection::Macros],
            },
        ])
        .unwrap();
    let result = output_receiver.recv_timeout(Duration::from_secs(2));
    control.send(()).unwrap();
    worker.join().unwrap();
    assert!(
        matches!(result.unwrap().as_slice(), [CoreEvent::OverlayChanged { role_ids }] if role_ids.is_empty())
    );
}

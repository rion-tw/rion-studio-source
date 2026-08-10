#[tokio::test]
async fn twenty_overlapping_jobs_release_the_next_admission_before_native_terminal() {
    for sample in 0..20 {
        let (mut first_signal, first_admitted) = LaunchAdmissionSignal::channel();
        let (release_first_native, first_native_released) = tokio::sync::oneshot::channel();
        let first_job = tokio::spawn(async move {
            first_signal.complete();
            let _ = first_native_released.await;
        });

        first_admitted.await.expect("first admission committed");
        assert!(
            !first_job.is_finished(),
            "sample {sample} must keep native execution pending after admission"
        );

        let (mut second_signal, mut second_admitted) = LaunchAdmissionSignal::channel();
        let second_job = tokio::spawn(async move {
            second_signal.complete();
        });
        tokio::task::yield_now().await;
        assert_eq!(
            second_admitted.try_recv(),
            Ok(()),
            "sample {sample} second admission must not wait for the first native terminal"
        );
        assert!(
            !first_job.is_finished(),
            "sample {sample} first native execution must still be blocked"
        );

        let _ = release_first_native.send(());
        first_job.await.expect("first tracked job completed");
        second_job.await.expect("second tracked job completed");
    }
}

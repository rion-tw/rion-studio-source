#[test]
fn native_zoom_factors_convert_to_exact_stored_percents() {
    for (factor, percent) in [
        (1.1, 110.0),
        (1.15, 115.0),
        (0.9, 90.0),
        (0.33, 33.0),
        (2.5, 250.0),
    ] {
        assert_eq!(zoom_factor_percent(factor), percent);
    }
    assert_ne!(1.1_f64 * 100.0, 110.0);
}

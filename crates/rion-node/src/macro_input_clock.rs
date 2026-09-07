use napi::{Error, Result, Status};
use napi_derive::napi;

/// Samples exactly the Core scheduler clock without entering Core's actor or
/// acquiring native-window state. No offset estimation or deadline translation.
#[napi]
pub fn macro_input_epoch_millis() -> Result<f64> {
    let now = rion_core::macro_input_epoch_millis();
    if now == 0 || now > 9_007_199_254_740_991 {
        return Err(Error::new(
            Status::GenericFailure,
            "The Core Macro clock is outside the exact JavaScript integer range.",
        ));
    }
    Ok(now as f64)
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_macro_clock_preserves_the_core_scheduler_sample_domain() {
        let before = rion_core::macro_input_epoch_millis();
        let sampled = super::macro_input_epoch_millis().unwrap();
        let after = rion_core::macro_input_epoch_millis();
        assert!(sampled.is_finite() && sampled.fract() == 0.0);
        assert!(sampled >= before as f64 && sampled <= after as f64);
    }
}

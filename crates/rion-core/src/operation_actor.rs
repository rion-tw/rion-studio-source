//! Bounded native effect operations, acknowledgements, cancellation, and compensation.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("operation_actor/section_01_default_pending_effect_capacity.rs");

#[cfg(test)]
mod tests;

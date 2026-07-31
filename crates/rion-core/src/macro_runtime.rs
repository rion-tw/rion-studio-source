//! Macro execution state, input sequencing, cancellation, and child invocation.
//!
//! Implementation sections are included at compile time and share one private module namespace.

include!("macro_runtime/section_01_action_timeout.rs");
include!("macro_runtime/section_02_new.rs");
include!("macro_runtime/section_03_stop_role_matching.rs");
include!("macro_runtime/section_04_start_child_invocation.rs");
include!("macro_runtime/section_05_discard_unstarted_invocation.rs");

#[cfg(test)]
mod tests;

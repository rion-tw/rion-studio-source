// Windows WebView2/Win32 adapter, statically selected at compile time.

include!("windows/input_security.rs");
include!("windows/lifecycle.rs");
#[cfg(windows)]
include!("windows/live_resize.rs");
include!("windows/material.rs");
include!("windows/reparent.rs");

#import <AppKit/AppKit.h>

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Stable-v22-only guard for Tao's Rust sendEvent callback and WKWebView's
// synthetic macro fallback. The Chromium/AppKit adapter must not call this.
bool rion_tauri_install_safe_tao_webkit_event_dispatch(void);

#ifdef __cplusplus
}
#endif

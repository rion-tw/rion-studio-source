use super::*;

#[napi(object)]
pub struct AppKitTabDragAnchor {
    pub x: f64,
    pub y: f64,
}

#[napi]
impl NativeAppKitRuntimeHost {
    #[napi(js_name = "containsDragPoint")]
    pub fn contains_drag_point(
        &self,
        expected: AppKitRuntimeHostIdentity,
        x: f64,
        y: f64,
    ) -> Result<bool> {
        self.with_controller_resource(&expected, |lease| {
            self.require_identity(&expected)?;
            self.require_exact_native_window()?;
            let controller = lease.pointer()?;
            // SAFETY: identity validation retains the live controller on AppKit main.
            unsafe { rion_appkit::runtime_tab_drag_contains(controller, x, y) }.map_err(|e| {
                adapter_error(
                    Status::GenericFailure,
                    format!("AppKit drag geometry: {e:?}"),
                )
            })
        })
    }
    #[napi(js_name = "dragAnchor")]
    pub fn drag_anchor(
        &self,
        expected: AppKitRuntimeHostIdentity,
        tab_id: String,
        ratio_x: f64,
        ratio_y: f64,
    ) -> Result<AppKitTabDragAnchor> {
        self.with_controller_resource(&expected, |lease| {
            self.require_identity(&expected)?;
            self.require_exact_native_window()?;
            let controller = lease.pointer()?;
            let tab = std::ffi::CString::new(tab_id).map_err(|_| malformed_projection_error())?;
            // SAFETY: identity validation retains the controller; tab lives through the call.
            let (x, y) =
                unsafe { rion_appkit::runtime_tab_drag_anchor(controller, &tab, ratio_x, ratio_y) }
                    .map_err(|e| {
                        adapter_error(Status::GenericFailure, format!("AppKit drag anchor: {e:?}"))
                    })?;
            Ok(AppKitTabDragAnchor { x, y })
        })
    }
}

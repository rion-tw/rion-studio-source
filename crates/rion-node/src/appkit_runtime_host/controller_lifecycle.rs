use std::{
    ffi::c_void,
    mem::ManuallyDrop,
    ptr::NonNull,
    sync::{Arc, Mutex, atomic::Ordering},
};

use napi::bindgen_prelude::Result;

use super::{
    AppKitCallbackContext, AppKitRuntimeHostIdentity, NativeAppKitRuntimeHost, destroy_controller,
    ensure_appkit_main_thread, host_destroyed_error, state_poisoned_error,
};

/// Owns the single native retain and the stable context captured by its blocks.
/// Arc leases share this ownership; they do not create unowned native pointers.
pub(super) struct ControllerResource {
    controller: usize,
    pub(super) context: ManuallyDrop<Box<AppKitCallbackContext>>,
}

impl ControllerResource {
    pub(super) fn new(controller: NonNull<c_void>, context: Box<AppKitCallbackContext>) -> Self {
        Self {
            controller: controller.as_ptr() as usize,
            context: ManuallyDrop::new(context),
        }
    }

    pub(super) fn pointer(&self) -> Result<NonNull<c_void>> {
        NonNull::new(self.controller as *mut c_void).ok_or_else(host_destroyed_error)
    }

    fn fence(&self) {
        self.context.accepting.store(false, Ordering::Release);
    }
}

impl Drop for ControllerResource {
    fn drop(&mut self) {
        self.fence();
        let destroyed = rion_appkit::runtime_tabs_is_main_thread()
            && self
                .pointer()
                .is_ok_and(|controller| destroy_controller(controller).is_ok());
        if destroyed {
            // SAFETY: the final Arc owns this Box exactly once. Native teardown
            // has returned, so no controller callback can access its context.
            unsafe { ManuallyDrop::drop(&mut self.context) };
        }
        // Off-main GC (or failed native teardown) intentionally leaks both the
        // retained controller and context, preserving the existing safe policy.
    }
}

/// Keeps logical ownership separate from projection/input metadata. AppKit can
/// synchronously call Electron, which may read layout before the outer call
/// returns; neither ownership nor metadata locks may span that layout read.
pub(super) struct ControllerLifecycle<T> {
    current: Mutex<Option<Arc<T>>>,
}

impl<T> ControllerLifecycle<T> {
    pub(super) fn new(resource: T) -> Self {
        Self {
            current: Mutex::new(Some(Arc::new(resource))),
        }
    }

    pub(super) fn acquire(&self) -> Result<Option<Arc<T>>> {
        Ok(self
            .current
            .lock()
            .map_err(|_| state_poisoned_error())?
            .clone())
    }

    pub(super) fn with_lease<R>(&self, operation: impl FnOnce(&T) -> Result<R>) -> Result<R> {
        let lease = self.acquire()?.ok_or_else(host_destroyed_error)?;
        let result = operation(&lease)?;
        self.require_current(&lease)?;
        Ok(result)
    }

    pub(super) fn require_current(&self, resource: &T) -> Result<()> {
        let current = self.current.lock().map_err(|_| state_poisoned_error())?;
        let live = current
            .as_ref()
            .is_some_and(|owner| std::ptr::eq(owner.as_ref(), resource));
        drop(current);
        if !live {
            return Err(host_destroyed_error());
        }
        Ok(())
    }

    /// Remove the owner before fencing callbacks or dropping the resource.
    /// Existing leases defer physical cleanup without retaining a mutex.
    pub(super) fn retire(&self, fence: impl FnOnce(&T)) -> Result<bool> {
        let retired = self
            .current
            .lock()
            .map_err(|_| state_poisoned_error())?
            .take();
        let Some(resource) = retired else {
            return Ok(false);
        };
        fence(&resource);
        drop(resource);
        Ok(true)
    }
}

impl NativeAppKitRuntimeHost {
    pub(super) fn with_controller_resource<T>(
        &self,
        expected: &AppKitRuntimeHostIdentity,
        operation: impl FnOnce(&ControllerResource) -> Result<T>,
    ) -> Result<T> {
        self.require_identity(expected)?;
        ensure_appkit_main_thread()?;
        self.lifecycle.with_lease(operation)
    }

    pub(super) fn with_live_controller<T>(
        &self,
        expected: &AppKitRuntimeHostIdentity,
        operation: impl FnOnce(NonNull<c_void>) -> Result<T>,
    ) -> Result<T> {
        self.with_controller_resource(expected, |lease| {
            lease.context.ensure_healthy()?;
            self.require_exact_native_window()?;
            let result = operation(lease.pointer()?)?;
            // A synchronous Electron callback may have retired the host. Check
            // logical ownership before touching its original native view again.
            self.lifecycle.require_current(lease)?;
            lease.context.ensure_healthy()?;
            self.require_exact_native_window()?;
            Ok(result)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{
        panic::{AssertUnwindSafe, catch_unwind},
        sync::{
            Arc, Mutex, Weak,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use super::*;

    struct ContextWitness(Arc<AtomicBool>);

    impl Drop for ContextWitness {
        fn drop(&mut self) {
            assert!(self.0.swap(false, Ordering::AcqRel));
        }
    }

    struct Resource {
        context: ContextWitness,
        destroys: Arc<AtomicUsize>,
        accepting: AtomicBool,
    }

    impl Drop for Resource {
        fn drop(&mut self) {
            // Native destruction may invoke its callback context. The context
            // must remain alive until native teardown has returned.
            assert!(self.context.0.load(Ordering::Acquire));
            self.destroys.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn fixture() -> (
        ControllerLifecycle<Resource>,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
    ) {
        let destroys = Arc::new(AtomicUsize::new(0));
        let context = Arc::new(AtomicBool::new(true));
        (
            ControllerLifecycle::new(Resource {
                context: ContextWitness(Arc::clone(&context)),
                destroys: Arc::clone(&destroys),
                accepting: AtomicBool::new(true),
            }),
            destroys,
            context,
        )
    }

    fn retire(lifecycle: &ControllerLifecycle<Resource>) -> Result<bool> {
        lifecycle.retire(|resource| resource.accepting.store(false, Ordering::Release))
    }

    #[test]
    fn synchronous_layout_reentry_uses_no_ownership_or_projection_lock() {
        let (lifecycle, destroys, _) = fixture();
        let projection = Mutex::new(());
        lifecycle
            .with_lease(|_| {
                let _projection = projection.lock().unwrap();
                // The old shared NativeHostState lock could not be acquired
                // here. Layout now leases only the separate live resource.
                assert!(projection.try_lock().is_err());
                assert!(lifecycle.current.try_lock().is_ok());
                lifecycle.with_lease(|_| Ok(()))
            })
            .unwrap();
        assert_eq!(destroys.load(Ordering::Acquire), 0);
        assert!(retire(&lifecycle).unwrap());
        assert_eq!(destroys.load(Ordering::Acquire), 1);
    }

    #[test]
    fn nested_retirement_fences_immediately_and_waits_for_all_leases() {
        let (lifecycle, destroys, context) = fixture();
        let outer = lifecycle.with_lease(|outer| {
            let nested = lifecycle.with_lease(|_| {
                assert!(retire(&lifecycle)?);
                assert!(!outer.accepting.load(Ordering::Acquire));
                assert!(!retire(&lifecycle)?);
                assert!(lifecycle.acquire()?.is_none());
                assert!(lifecycle.with_lease(|_| Ok(())).is_err());
                assert_eq!(destroys.load(Ordering::Acquire), 0);
                assert!(context.load(Ordering::Acquire));
                Ok(())
            });
            assert!(nested.is_err());
            assert_eq!(destroys.load(Ordering::Acquire), 0);
            assert!(context.load(Ordering::Acquire));
            Ok(())
        });
        assert!(outer.is_err());
        assert_eq!(destroys.load(Ordering::Acquire), 1);
        assert!(!context.load(Ordering::Acquire));
        assert!(!retire(&lifecycle).unwrap());
        drop(lifecycle);
        assert_eq!(destroys.load(Ordering::Acquire), 1);
    }

    #[test]
    fn native_errors_release_the_lease_without_poisoning_ownership() {
        let (lifecycle, destroys, _) = fixture();
        assert!(
            lifecycle
                .with_lease::<()>(|_| Err(host_destroyed_error()))
                .is_err()
        );
        lifecycle.with_lease(|_| Ok(())).unwrap();
        assert!(retire(&lifecycle).unwrap());
        assert_eq!(destroys.load(Ordering::Acquire), 1);
    }

    #[test]
    fn retirement_does_not_replace_the_original_native_error() {
        let (lifecycle, destroys, context) = fixture();
        let failure = lifecycle.with_lease::<()>(|_| {
            assert!(retire(&lifecycle)?);
            Err(napi::Error::from_reason("original native failure"))
        });
        assert_eq!(failure.unwrap_err().reason, "original native failure");
        assert_eq!(destroys.load(Ordering::Acquire), 1);
        assert!(!context.load(Ordering::Acquire));
    }

    #[test]
    fn final_cleanup_can_reenter_after_both_metadata_and_owner_locks_release() {
        struct ReentrantCleanup {
            lifecycle: Mutex<Weak<ControllerLifecycle<Self>>>,
            metadata: Arc<Mutex<()>>,
            destroyed: Arc<AtomicBool>,
        }

        impl Drop for ReentrantCleanup {
            fn drop(&mut self) {
                let lifecycle = self.lifecycle.lock().unwrap().upgrade().unwrap();
                assert!(lifecycle.current.try_lock().is_ok());
                assert!(self.metadata.try_lock().is_ok());
                assert!(lifecycle.with_lease(|_| Ok(())).is_err());
                assert!(!self.destroyed.swap(true, Ordering::AcqRel));
            }
        }

        let metadata = Arc::new(Mutex::new(()));
        let destroyed = Arc::new(AtomicBool::new(false));
        let lifecycle = Arc::new(ControllerLifecycle::new(ReentrantCleanup {
            lifecycle: Mutex::new(Weak::new()),
            metadata: Arc::clone(&metadata),
            destroyed: Arc::clone(&destroyed),
        }));
        *lifecycle
            .acquire()
            .unwrap()
            .unwrap()
            .lifecycle
            .lock()
            .unwrap() = Arc::downgrade(&lifecycle);
        let result = lifecycle.with_lease(|_| {
            let _metadata = metadata.lock().unwrap();
            assert!(lifecycle.retire(|_| {})?);
            assert!(!destroyed.load(Ordering::Acquire));
            Ok(())
        });
        assert!(result.is_err());
        assert!(destroyed.load(Ordering::Acquire));
    }

    #[test]
    fn unwind_after_retirement_destroys_once_outside_the_ownership_lock() {
        let (lifecycle, destroys, context) = fixture();
        let panic = catch_unwind(AssertUnwindSafe(|| {
            let _ = lifecycle.with_lease::<()>(|_| {
                assert!(retire(&lifecycle).unwrap());
                assert!(lifecycle.current.try_lock().is_ok());
                panic!("native operation unwound");
            });
        }));
        assert!(panic.is_err());
        assert_eq!(destroys.load(Ordering::Acquire), 1);
        assert!(!context.load(Ordering::Acquire));
        assert!(!retire(&lifecycle).unwrap());
    }
}

const NATIVE_WINDOW_PRESENTATION_QUEUE_CAPACITY: usize = 64;

fn native_presentation_requires_ordering(
    focus: NativePresentationFocus,
    window_mode: Option<NativeWindowMode>,
    window_visibility: Option<bool>,
) -> bool {
    // A passive hydration projection must not replace an explicit focus
    // request. Stale requests still terminalize through the actor's fences.
    focus.focuses_content() || window_mode.is_some() || window_visibility.is_some()
}

struct NativePresentationQueue<T> {
    in_flight: bool,
    pending: VecDeque<(bool, T)>,
}

impl<T> Default for NativePresentationQueue<T> {
    fn default() -> Self {
        Self {
            in_flight: false,
            pending: VecDeque::new(),
        }
    }
}

impl<T> NativePresentationQueue<T> {
    fn enqueue_latest(&mut self, value: T) -> Result<Option<T>, T> {
        if let Some((ordered, pending)) = self.pending.back_mut()
            && !*ordered
        {
            return Ok(Some(std::mem::replace(pending, value)));
        }
        if self.pending.len() >= NATIVE_WINDOW_PRESENTATION_QUEUE_CAPACITY {
            return Err(value);
        }
        self.pending.push_back((false, value));
        Ok(None)
    }

    fn enqueue_ordered(&mut self, value: T) -> Result<(), T> {
        if self.pending.len() >= NATIVE_WINDOW_PRESENTATION_QUEUE_CAPACITY {
            return Err(value);
        }
        self.pending.push_back((true, value));
        Ok(())
    }

    fn begin_next(&mut self) -> Option<T> {
        if self.in_flight {
            return None;
        }
        let (_, next) = self.pending.pop_front()?;
        self.in_flight = true;
        Some(next)
    }

    fn finish(&mut self) {
        self.in_flight = false;
    }

    fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    fn back(&self) -> Option<&T> {
        self.pending.back().map(|(_, request)| request)
    }

    fn drain(&mut self) -> impl Iterator<Item = T> + '_ {
        self.pending.drain(..).map(|(_, request)| request)
    }
}

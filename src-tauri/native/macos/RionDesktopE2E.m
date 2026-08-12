#import <AppKit/AppKit.h>

typedef struct {
  double content_height;
  double content_width;
  int64_t display_id;
  bool fullscreen;
  bool maximized;
  bool minimized;
  double outer_height;
  double outer_width;
  double outer_x;
  double outer_y;
  double scale_factor;
  double work_height;
  double work_width;
  double work_x;
  double work_y;
} RionDesktopE2EWindowSnapshot;

static CGFloat RionDesktopTop(void) {
  CGFloat top = 0.0;
  for (NSScreen *screen in NSScreen.screens) {
    top = MAX(top, NSMaxY(screen.frame));
  }
  return top;
}

bool rion_desktop_e2e_control_window(void *rawWindow, int32_t action,
                                     double x, double y, double width,
                                     double height) {
  NSWindow *window = (__bridge NSWindow *)rawWindow;
  if (!window) return false;
  switch (action) {
    case 0: {
      if ((window.styleMask & NSWindowStyleMaskFullScreen) != 0) return false;
      if (window.miniaturized) [window deminiaturize:nil];
      if (window.zoomed) [window performZoom:nil];
      // Use AppKit's semantic resize and move entry points independently. They
      // emit the same did-resize/did-move notifications consumed by the product
      // observer, unlike a direct frame replacement on an off-key test window.
      [window setContentSize:NSMakeSize(width, height)];
      const NSRect frame = window.frame;
      [window setFrameOrigin:NSMakePoint(
          x, RionDesktopTop() - y - frame.size.height)];
      [window displayIfNeeded];
      return true;
    }
    case 1:
      if (window.miniaturized) {
        __block id observer = nil;
        observer = [NSNotificationCenter.defaultCenter
            addObserverForName:NSWindowDidDeminiaturizeNotification
                        object:window
                         queue:NSOperationQueue.mainQueue
                    usingBlock:^(__unused NSNotification *notification) {
          [NSNotificationCenter.defaultCenter removeObserver:observer];
          observer = nil;
          if (window.zoomed) [window performZoom:nil];
        }];
        [window deminiaturize:nil];
        return true;
      }
      if ((window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
        [window toggleFullScreen:nil];
      } else if (window.zoomed) {
        [window performZoom:nil];
      }
      return true;
    case 2:
      if (window.miniaturized) [window deminiaturize:nil];
      if ((window.styleMask & NSWindowStyleMaskFullScreen) != 0) return false;
      if (!window.zoomed) [window performZoom:nil];
      return true;
    case 3:
      [window miniaturize:nil];
      return true;
    case 4:
      if (window.miniaturized) [window deminiaturize:nil];
      if ((window.styleMask & NSWindowStyleMaskFullScreen) == 0) {
        [window toggleFullScreen:nil];
      }
      return true;
    case 5:
      [window performClose:nil];
      return true;
    default:
      return false;
  }
}

bool rion_desktop_e2e_read_window(void *rawWindow,
                                  RionDesktopE2EWindowSnapshot *snapshot) {
  NSWindow *window = (__bridge NSWindow *)rawWindow;
  if (!window || !snapshot) return false;
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  if (!screen) return false;
  const CGFloat desktopTop = RionDesktopTop();
  const NSRect frame = window.frame;
  const NSRect content = [window contentRectForFrameRect:frame];
  const NSRect work = screen.visibleFrame;
  NSNumber *screenNumber = screen.deviceDescription[@"NSScreenNumber"];
  snapshot->content_height = content.size.height;
  snapshot->content_width = content.size.width;
  snapshot->display_id = screenNumber.longLongValue;
  snapshot->fullscreen =
      (window.styleMask & NSWindowStyleMaskFullScreen) != 0;
  snapshot->maximized = window.zoomed;
  snapshot->minimized = window.miniaturized;
  snapshot->outer_height = frame.size.height;
  snapshot->outer_width = frame.size.width;
  snapshot->outer_x = frame.origin.x;
  snapshot->outer_y = desktopTop - NSMaxY(frame);
  snapshot->scale_factor = screen.backingScaleFactor;
  snapshot->work_height = work.size.height;
  snapshot->work_width = work.size.width;
  snapshot->work_x = work.origin.x;
  snapshot->work_y = desktopTop - NSMaxY(work);
  return true;
}

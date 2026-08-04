NS_ASSUME_NONNULL_BEGIN

@implementation RionRuntimeTabModel
@end

@implementation RionRuntimeDraggableView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeWindowNameField

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeBackdropView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)mouseDownCanMoveWindow {
  return YES;
}

@end

@implementation RionRuntimeVerticallyCenteredTextFieldCell

- (NSRect)titleRectForBounds:(NSRect)bounds {
  NSRect titleRect = [super titleRectForBounds:bounds];
  NSFont *font = self.font;
  if (!font || NSHeight(bounds) <= 0) return titleRect;

  CGFloat metricHeight = ceil(font.ascender - font.descender + font.leading);
  CGFloat titleHeight = MIN(NSHeight(bounds), MAX(0, metricHeight));
  titleRect.origin.y =
      NSMinY(bounds) + (NSHeight(bounds) - titleHeight) / 2.0;
  titleRect.size.height = titleHeight;
  return titleRect;
}

- (void)drawInteriorWithFrame:(NSRect)cellFrame
                       inView:(NSView *)controlView {
  [super drawInteriorWithFrame:[self titleRectForBounds:cellFrame]
                        inView:controlView];
}

@end

@implementation RionRuntimeHorizontalScrollView

- (void)scrollWheel:(NSEvent *)event {
  if (std::fabs(event.scrollingDeltaX) >= std::fabs(event.scrollingDeltaY)) {
    [super scrollWheel:event];
    return;
  }
  NSClipView *clipView = self.contentView;
  CGFloat scale = event.hasPreciseScrollingDeltas ? 1.0 : 14.0;
  CGFloat maximumOrigin =
      MAX(0, self.documentView.frame.size.width - clipView.bounds.size.width);
  CGFloat originX = MIN(
      maximumOrigin,
      MAX(0, clipView.bounds.origin.x - event.scrollingDeltaY * scale));
  [clipView scrollToPoint:NSMakePoint(originX, clipView.bounds.origin.y)];
  [self reflectScrolledClipView:clipView];
}

@end

NS_ASSUME_NONNULL_END

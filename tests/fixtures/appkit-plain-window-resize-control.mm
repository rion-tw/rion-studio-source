#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <dispatch/dispatch.h>
#include <cstdlib>
#include <cstdio>
#include <unistd.h>

NS_ASSUME_NONNULL_BEGIN

static NSDictionary *PlainControlRect(NSRect value) {
  return @{ @"x" : @(value.origin.x), @"y" : @(value.origin.y),
            @"width" : @(value.size.width), @"height" : @(value.size.height) };
}
static NSDictionary *PlainControlSize(NSSize value) {
  return @{ @"width" : @(value.width), @"height" : @(value.height) };
}
static NSDictionary *Buttons(void) {
  return @{ @"hidLeft" : @(CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonLeft)),
            @"combinedLeft" : @(CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft)),
            @"appKitLeft" : @((NSEvent.pressedMouseButtons & 1) != 0) };
}
static BOOL Neutral(NSDictionary *buttons) {
  return ![buttons[@"hidLeft"] boolValue] && ![buttons[@"combinedLeft"] boolValue] &&
         ![buttons[@"appKitLeft"] boolValue];
}
static void Publish(NSDictionary *value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
  if (!data) {
    fprintf(stderr, "control JSON serialization failed: %s\n", error.localizedDescription.UTF8String);
    std::exit(1);
  }
  [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

@interface PlainResizeControl : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong, nullable) NSWindow *window;
@property(nonatomic, copy) NSString *windowId;
@property(nonatomic, copy) NSString *nonce;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *records;
@property(nonatomic) NSUInteger sequence;
@property(nonatomic) NSUInteger dropped;
@property(nonatomic) BOOL readySent;
@property(nonatomic) BOOL closeRequested;
@property(nonatomic) BOOL launchFinished;
@property(nonatomic) BOOL launchTurnObserved;
- (void)receiveCommand:(NSDictionary *)command;
@end

@implementation PlainResizeControl
- (instancetype)init {
  if ((self = [super init])) _records = [NSMutableArray array];
  return self;
}
- (NSDictionary *)snapshot {
  NSWindow *window = self.window;
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  NSScreen *primary = NSScreen.screens.firstObject;
  NSUInteger visibleCount = 0;
  for (NSWindow *candidate in NSApp.windows) if (candidate.visible) ++visibleCount;
  CGEventRef pointerEvent = CGEventCreate(NULL);
  CGPoint pointer = pointerEvent ? CGEventGetLocation(pointerEvent) : CGPointMake(NAN, NAN);
  if (pointerEvent) CFRelease(pointerEvent);
  return @{ @"processId" : @(getpid()), @"windowId" : self.windowId,
            @"axIdentifier" : window.accessibilityIdentifier ?: @"",
            @"windowNumber" : @(window.windowNumber),
            @"windowPointer" : [NSString stringWithFormat:@"%p", window],
            @"visible" : @(window.visible), @"key" : @(window.keyWindow),
            @"main" : @(window.mainWindow), @"applicationActive" : @(NSApp.active),
            @"launchFinished" : @(self.launchFinished), @"launchTurnObserved" : @(self.launchTurnObserved),
            @"ownedVisibleWindowCount" : @(visibleCount),
            @"frame" : PlainControlRect(window.frame), @"minimumSize" : PlainControlSize(window.minSize),
            @"quartzFrame" : PlainControlRect(NSMakeRect(window.frame.origin.x,
                NSMaxY(primary.frame) - NSMaxY(window.frame), window.frame.size.width, window.frame.size.height)),
            @"contentMinimumSize" : PlainControlSize(window.contentMinSize),
            @"contentBounds" : PlainControlRect(window.contentView.bounds),
            @"contentLayoutRect" : PlainControlRect(window.contentLayoutRect),
            @"styleMask" : @(window.styleMask), @"inLiveResize" : @(window.inLiveResize),
            @"screenFrame" : PlainControlRect(screen.frame), @"visibleFrame" : PlainControlRect(screen.visibleFrame),
            @"backingScaleFactor" : @(screen.backingScaleFactor),
            @"pointer" : @{ @"x" : @(pointer.x), @"y" : @(pointer.y) },
            @"buttons" : Buttons() };
}
- (void)record:(NSString *)reason proposedSize:(nullable NSValue *)proposed {
  NSMutableDictionary *entry = [[self snapshot] mutableCopy];
  entry[@"sequence"] = @(++self.sequence);
  entry[@"reason"] = reason;
  entry[@"capturedAtUnixSeconds"] = @(NSDate.date.timeIntervalSince1970);
  if (proposed) entry[@"proposedSize"] = PlainControlSize(proposed.sizeValue);
  NSEvent *event = NSApp.currentEvent;
  if (event) {
    const BOOL pointerEvent = event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseUp ||
        event.type == NSEventTypeRightMouseDown || event.type == NSEventTypeRightMouseUp ||
        event.type == NSEventTypeOtherMouseDown || event.type == NSEventTypeOtherMouseUp ||
        event.type == NSEventTypeMouseMoved || event.type == NSEventTypeLeftMouseDragged ||
        event.type == NSEventTypeRightMouseDragged || event.type == NSEventTypeOtherMouseDragged;
    const BOOL hasMouseDelta = event.type == NSEventTypeMouseMoved ||
        event.type == NSEventTypeLeftMouseDragged || event.type == NSEventTypeRightMouseDragged ||
        event.type == NSEventTypeOtherMouseDragged;
    if (pointerEvent) {
      CGEventRef native = event.CGEvent;
      entry[@"currentEvent"] = @{
        @"windowMatches" : @(event.window == self.window), @"windowNumber" : @(event.windowNumber),
        @"type" : @(event.type), @"timestamp" : @(event.timestamp),
        @"locationX" : @(event.locationInWindow.x), @"locationY" : @(event.locationInWindow.y),
        @"deltaX" : @(hasMouseDelta ? event.deltaX : 0), @"deltaY" : @(hasMouseDelta ? event.deltaY : 0),
        @"sourceProcessId" : @(native ? CGEventGetIntegerValueField(native, kCGEventSourceUnixProcessID) : -1) };
    } else entry[@"currentEvent"] = @{ @"type" : @(event.type), @"pointerFieldsAvailable" : @NO };
  }
  if (self.records.count == 128) { [self.records removeObjectAtIndex:0]; ++self.dropped; }
  [self.records addObject:entry];
}
- (void)maybeReady {
  NSWindow *window = self.window;
  if (self.readySent || !self.launchFinished || !self.launchTurnObserved ||
      !window.visible || !window.keyWindow || !window.mainWindow || !NSApp.active) return;
  self.readySent = YES;
  [self record:@"ready" proposedSize:nil];
  Publish(@{ @"stage" : @"ready", @"nonce" : self.nonce, @"snapshot" : [self snapshot] });
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  if (!Neutral(Buttons())) {
    Publish(@{ @"stage" : @"infrastructure-error", @"nonce" : self.nonce,
               @"reason" : @"left button was held before control setup", @"buttons" : Buttons() });
    std::exit(1);
  }
  NSScreen *screen = NSScreen.mainScreen;
  if (!screen || screen.visibleFrame.size.width < 960 || screen.visibleFrame.size.height < 677) {
    Publish(@{ @"stage" : @"infrastructure-error", @"nonce" : self.nonce,
               @"reason" : @"visible screen cannot contain the requested 960x677 control" });
    std::exit(1);
  }
  NSRect visible = screen.visibleFrame;
  CGFloat inset = MIN((CGFloat)56, MAX((CGFloat)0, visible.size.width - 960));
  NSRect frame = NSMakeRect(NSMinX(visible) + inset, NSMaxY(visible) - 677, 960, 677);
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 960, 640)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
  self.window.releasedWhenClosed = NO;
  self.window.title = @"Rion diagnostic plain Cocoa resize control";
  self.window.accessibilityIdentifier = [@"com.rionstudio.runtime.appkit-window.v1:" stringByAppendingString:self.windowId];
  self.window.delegate = self;
  // Match the observed raw frame minimum. Preserve Cocoa's default content
  // minimum/insets; this control does not invent an Electron content constraint.
  self.window.minSize = NSMakeSize(640, 512);
  [self.window setFrame:frame display:NO];
  [self record:@"configured" proposedSize:nil];
  [self.window makeKeyAndOrderFront:nil];
  if (@available(macOS 14.0, *)) [NSApp activate];
  else {
    Publish(@{ @"stage" : @"infrastructure-error", @"nonce" : self.nonce,
               @"reason" : @"the diagnostic control requires macOS 14 or newer" });
    std::exit(1);
  }
  self.launchFinished = YES;
  dispatch_async(dispatch_get_main_queue(), ^{
    self.launchTurnObserved = YES;
    [self maybeReady];
  });
}
- (void)applicationDidBecomeActive:(NSNotification *)notification { (void)notification; [self maybeReady]; }
- (void)windowDidBecomeKey:(NSNotification *)notification { (void)notification; [self maybeReady]; }
- (void)windowDidBecomeMain:(NSNotification *)notification { (void)notification; [self maybeReady]; }
- (void)windowWillStartLiveResize:(NSNotification *)notification {
  (void)notification; [self record:@"WillStartLiveResize" proposedSize:nil];
}
- (void)windowDidResize:(NSNotification *)notification {
  (void)notification; [self record:@"DidResize" proposedSize:nil];
}
- (void)windowDidEndLiveResize:(NSNotification *)notification {
  (void)notification; [self record:@"DidEndLiveResize" proposedSize:nil];
}
- (NSSize)windowWillResize:(NSWindow *)sender toSize:(NSSize)size {
  if (sender == self.window) [self record:@"windowWillResize:unchanged-return" proposedSize:[NSValue valueWithSize:size]];
  return size;
}
- (void)receiveCommand:(NSDictionary *)command {
  if (self.closeRequested || ![command[@"nonce"] isEqual:self.nonce]) {
    Publish(@{ @"stage" : @"infrastructure-error", @"nonce" : self.nonce,
               @"reason" : @"unexpected control command" });
    std::exit(1);
  }
  if ([command[@"command"] isEqual:@"checkpoint"] && self.readySent &&
      [@[@"right", @"bottom"] containsObject:command[@"name"]]) {
    [self record:[@"checkpoint:" stringByAppendingString:command[@"name"]] proposedSize:nil];
    Publish(@{ @"stage" : @"checkpoint", @"nonce" : self.nonce,
               @"name" : command[@"name"], @"snapshot" : [self snapshot] });
    return;
  }
  if (![command[@"command"] isEqual:@"close"]) {
    Publish(@{ @"stage" : @"infrastructure-error", @"nonce" : self.nonce,
               @"reason" : @"unknown control command" });
    std::exit(1);
  }
  self.closeRequested = YES;
  NSDictionary *before = [self snapshot];
  [self.window close];
  [self record:@"closed" proposedSize:nil];
  Publish(@{ @"stage" : @"closed", @"nonce" : self.nonce,
             @"beforeClose" : before, @"afterClose" : [self snapshot],
             @"journal" : @{ @"capacity" : @128, @"sequence" : @(self.sequence),
                             @"dropped" : @(self.dropped), @"records" : self.records },
             @"coverage" : @"Delegate/notification snapshots; not an all-input event journal" });
  [NSApp terminate:nil];
}
@end

int main(int argc, const char * _Nonnull * _Nonnull argv) {
  @autoreleasepool {
    if (argc != 3) { fprintf(stderr, "expected exact window ID and nonce\n"); return 1; }
    PlainResizeControl *control = [PlainResizeControl new];
    control.windowId = [NSString stringWithUTF8String:argv[1]];
    control.nonce = [NSString stringWithUTF8String:argv[2]];
    if (!Neutral(Buttons())) {
      Publish(@{ @"stage" : @"infrastructure-error", @"nonce" : control.nonce,
                 @"reason" : @"left button was held at control startup", @"buttons" : Buttons() });
      return 1;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSApp.delegate = control;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      @autoreleasepool {
        char input[1024];
        while (fgets(input, sizeof(input), stdin)) {
          NSDictionary *command = nil;
          NSData *data = [[NSString stringWithUTF8String:input] dataUsingEncoding:NSUTF8StringEncoding];
          id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
          if ([value isKindOfClass:NSDictionary.class]) command = value;
          dispatch_async(dispatch_get_main_queue(), ^{ [control receiveCommand:command ?: @{}]; });
          if ([command[@"command"] isEqual:@"close"]) return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{ [control receiveCommand:@{}]; });
      }
    });
    [NSApp run];
    return 1; // Only the exact close command may terminate this process cleanly.
  }
}
NS_ASSUME_NONNULL_END

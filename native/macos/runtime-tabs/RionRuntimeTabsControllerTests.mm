#import <AppKit/AppKit.h>

#include <cstdlib>
#include <iostream>

#import "RionRuntimeTabsController.h"

@interface RionRuntimeTabsController (RionRuntimeTabsTests)

- (void)handleDropWithTabIdentifier:(NSString *)tabIdentifier
                    sourceDisplayID:(NSInteger)sourceDisplayID
                   beforeIdentifier:(nullable NSString *)beforeIdentifier;

@end

static void Assert(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << std::endl;
    std::exit(1);
  }
}

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 900, 600)
                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable |
                            NSWindowStyleMaskResizable
                    backing:NSBackingStoreBuffered
                      defer:NO];
    Assert([window standardWindowButton:NSWindowCloseButton] != nil,
           "Expected a standard close button before attaching runtime tabs.");

    __block NSDictionary<NSString *, id> *lastAction = nil;
    RionRuntimeTabsController *controller = [[RionRuntimeTabsController alloc]
        initWithWindow:window
         actionHandler:^(NSDictionary<NSString *, id> *action) {
      lastAction = action;
    }];
    Assert(controller != nil, "Expected the native runtime tabs controller.");
    Assert(window.titleVisibility == NSWindowTitleHidden,
           "Expected the native title to be hidden.");
    Assert(window.titlebarAccessoryViewControllers.count == 1,
           "Expected one titlebar accessory controller.");
    Assert([window standardWindowButton:NSWindowCloseButton] != nil,
           "Attaching runtime tabs must preserve standard traffic lights.");

    RionRuntimeTabModel *role = [[RionRuntimeTabModel alloc] init];
    role.active = YES;
    role.identifier = @"tab-1";
    role.name = @"Mina";
    role.roleCount = 0;
    role.type = @"role";
    RionRuntimeTabModel *workspace = [[RionRuntimeTabModel alloc] init];
    workspace.active = NO;
    workspace.identifier = @"tab-2";
    workspace.name = @"Team";
    workspace.roleCount = 4;
    workspace.type = @"workspace";
    workspace.workspaceTemplate = @"quad";
    RionRuntimeTabsState *state = [[RionRuntimeTabsState alloc] init];
    state.addLabel = @"Add";
    state.displayID = 11;
    state.moreLabel = @"More";
    state.tabs = @[ role, workspace ];
    [controller updateState:state];
    Assert(controller.renderedTabCount == 2, "Expected two rendered native tabs.");

    NSButton *addButton =
        [controller valueForKeyPath:@"_accessoryController.view"]
            ? [[controller valueForKeyPath:@"_accessoryController.view"]
                  viewWithTag:41001]
            : nil;
    Assert(addButton != nil, "Expected the native add button.");
    [addButton performClick:nil];
    Assert([lastAction[@"type"] isEqualToString:@"openLauncher"],
           "Expected the add button to emit openLauncher.");

    [controller handleDropWithTabIdentifier:@"tab-2"
                            sourceDisplayID:11
                           beforeIdentifier:@"tab-1"];
    Assert([lastAction[@"type"] isEqualToString:@"reorder"] &&
               [lastAction[@"tabId"] isEqualToString:@"tab-2"] &&
               [lastAction[@"beforeTabId"] isEqualToString:@"tab-1"],
           "Expected a same-display drag to emit a reorder action.");
    [controller handleDropWithTabIdentifier:@"tab-2"
                            sourceDisplayID:22
                           beforeIdentifier:nil];
    Assert([lastAction[@"type"] isEqualToString:@"move"] &&
               [lastAction[@"tabId"] isEqualToString:@"tab-2"] &&
               [lastAction[@"displayId"] integerValue] == 11,
           "Expected a cross-display drag to emit a move action.");

    [controller setAlwaysShowInFullScreen:YES];
    Assert(controller.alwaysShowInFullScreen,
           "Expected the always-show fullscreen policy.");
    [controller setRevealLocked:YES];
    Assert(controller.revealLocked, "Expected the native reveal lock.");

    [controller destroy];
    Assert(window.titlebarAccessoryViewControllers.count == 0,
           "Destroying the controller must detach its accessory.");
    Assert([window standardWindowButton:NSWindowCloseButton] != nil,
           "Destroying runtime tabs must preserve standard traffic lights.");
  }
  std::cout << "macOS runtime tabs native tests passed" << std::endl;
  return 0;
}

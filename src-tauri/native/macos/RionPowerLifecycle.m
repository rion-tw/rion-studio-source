#import <AppKit/AppKit.h>
#include <stdbool.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (*RionPowerLifecycleCallback)(void *context, bool suspended, const char *reason);
typedef void (*RionDisplayTopologyCallback)(void *context, const char *reason);
typedef void (*RionPowerLifecycleDestructor)(void *context);

@interface RionPowerLifecycleMonitor : NSObject
@property(nonatomic, assign) RionPowerLifecycleCallback callback;
@property(nonatomic, assign) RionDisplayTopologyCallback displayCallback;
@property(nonatomic, assign) void *context;
@property(nonatomic, assign) RionPowerLifecycleDestructor contextDestructor;
@end

@implementation RionPowerLifecycleMonitor

- (instancetype)initWithCallback:(RionPowerLifecycleCallback)callback
                 displayCallback:(RionDisplayTopologyCallback)displayCallback
                          context:(void *)context
                contextDestructor:(RionPowerLifecycleDestructor)contextDestructor {
    self = [super init];
    if (self) {
        _callback = callback;
        _displayCallback = displayCallback;
        _context = context;
        _contextDestructor = contextDestructor;
        NSNotificationCenter *notifications = NSWorkspace.sharedWorkspace.notificationCenter;
        [notifications addObserver:self
                          selector:@selector(workspaceWillSleep:)
                              name:NSWorkspaceWillSleepNotification
                            object:nil];
        [NSNotificationCenter.defaultCenter
            addObserver:self
               selector:@selector(screenParametersChanged:)
                   name:NSApplicationDidChangeScreenParametersNotification
                 object:nil];
        [notifications addObserver:self
                          selector:@selector(workspaceDidWake:)
                              name:NSWorkspaceDidWakeNotification
                            object:nil];
    }
    return self;
}

- (void)screenParametersChanged:(NSNotification *)notification {
    (void)notification;
    self.displayCallback(self.context, "macos-screen-parameters-changed");
}

- (void)workspaceWillSleep:(NSNotification *)notification {
    (void)notification;
    self.callback(self.context, true, "macos-workspace-will-sleep");
}

- (void)workspaceDidWake:(NSNotification *)notification {
    (void)notification;
    self.callback(self.context, false, "macos-workspace-did-wake");
}

- (void)dealloc {
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
    [NSNotificationCenter.defaultCenter removeObserver:self];
    if (_context != NULL) {
        _contextDestructor(_context);
        _context = NULL;
    }
}

@end

void * _Nullable rion_power_monitor_create(
    RionPowerLifecycleCallback callback,
    RionDisplayTopologyCallback displayCallback,
    void *context,
    RionPowerLifecycleDestructor contextDestructor
) {
    RionPowerLifecycleMonitor *monitor =
        [[RionPowerLifecycleMonitor alloc] initWithCallback:callback
                                           displayCallback:displayCallback
                                                   context:context
                                         contextDestructor:contextDestructor];
    return (__bridge_retained void *)monitor;
}

void rion_power_monitor_release(void * _Nullable rawMonitor) {
    if (rawMonitor == NULL) {
        return;
    }
    RionPowerLifecycleMonitor *monitor = (__bridge_transfer RionPowerLifecycleMonitor *)rawMonitor;
    (void)monitor;
}

NS_ASSUME_NONNULL_END

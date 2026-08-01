#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <stdbool.h>

static __strong NSMenu *RionDockMenu = nil;

bool rion_dock_menu_activate_application(void) {
    if (![NSThread isMainThread]) {
        return false;
    }

    [NSApp unhide:nil];
    [NSApp activate];
    return true;
}

static NSMenu *RionApplicationDockMenu(id self, SEL command, NSApplication *application) {
    (void)self;
    (void)command;
    (void)application;
    return RionDockMenu;
}

static bool RionInstallDockSelectorOnClass(Class delegateClass) {
    if (delegateClass == Nil) {
        return false;
    }

    SEL selector = @selector(applicationDockMenu:);
    Method existing = class_getInstanceMethod(delegateClass, selector);
    if (existing != NULL) {
        return method_getImplementation(existing) == (IMP)RionApplicationDockMenu;
    }

    return class_addMethod(
        delegateClass,
        selector,
        (IMP)RionApplicationDockMenu,
        "@@:@"
    );
}

bool rion_dock_menu_set_menu(void *rawMenu) {
    if (![NSThread isMainThread] || rawMenu == NULL) {
        return false;
    }

    id delegate = NSApp.delegate;
    if (delegate == nil || !RionInstallDockSelectorOnClass(object_getClass(delegate))) {
        return false;
    }

    RionDockMenu = (__bridge NSMenu *)rawMenu;
    return true;
}

static NSMenu *RionForeignDockMenu(id self, SEL command, NSApplication *application) {
    (void)self;
    (void)command;
    (void)application;
    return nil;
}

bool rion_dock_menu_adapter_self_test(void) {
    NSString *suffix = NSUUID.UUID.UUIDString;
    NSString *installName = [@"RionDockMenuInstallTest_" stringByAppendingString:suffix];
    Class installClass = objc_allocateClassPair(
        NSObject.class,
        installName.UTF8String,
        0
    );
    if (installClass == Nil) {
        return false;
    }
    objc_registerClassPair(installClass);
    if (!RionInstallDockSelectorOnClass(installClass)) {
        return false;
    }
    Method installed = class_getInstanceMethod(installClass, @selector(applicationDockMenu:));
    if (installed == NULL || method_getImplementation(installed) != (IMP)RionApplicationDockMenu) {
        return false;
    }

    typedef NSMenu *(*RionDockMenuImplementation)(id, SEL, NSApplication *);
    RionDockMenuImplementation resolveMenu =
        (RionDockMenuImplementation)method_getImplementation(installed);
    id installDelegate = [[installClass alloc] init];
    NSMenu *previousMenu = RionDockMenu;
    NSMenu *firstMenu = [[NSMenu alloc] initWithTitle:@"First Dock Menu"];
    NSMenu *secondMenu = [[NSMenu alloc] initWithTitle:@"Second Dock Menu"];
    RionDockMenu = firstMenu;
    bool firstMatches = resolveMenu(
        installDelegate,
        @selector(applicationDockMenu:),
        nil
    ) == firstMenu;
    RionDockMenu = secondMenu;
    bool secondMatches = resolveMenu(
        installDelegate,
        @selector(applicationDockMenu:),
        nil
    ) == secondMenu;
    RionDockMenu = previousMenu;
    if (!firstMatches || !secondMatches) {
        return false;
    }

    NSString *conflictName = [@"RionDockMenuConflictTest_" stringByAppendingString:suffix];
    Class conflictClass = objc_allocateClassPair(
        NSObject.class,
        conflictName.UTF8String,
        0
    );
    if (conflictClass == Nil) {
        return false;
    }
    if (!class_addMethod(
            conflictClass,
            @selector(applicationDockMenu:),
            (IMP)RionForeignDockMenu,
            "@@:@"
        )) {
        return false;
    }
    objc_registerClassPair(conflictClass);
    if (RionInstallDockSelectorOnClass(conflictClass)) {
        return false;
    }

    return true;
}

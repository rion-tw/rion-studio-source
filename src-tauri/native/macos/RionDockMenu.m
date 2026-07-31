#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <stdbool.h>
#include <stdint.h>

static __strong NSMenu *RionDockMenu = nil;

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

static bool RionPromoteSectionHeader(void *rawMenu, uintptr_t index) {
    if (rawMenu == NULL) {
        return false;
    }

    NSMenu *menu = (__bridge NSMenu *)rawMenu;
    if ((NSUInteger)index >= (NSUInteger)menu.numberOfItems) {
        return false;
    }

    NSMenuItem *existing = [menu itemAtIndex:index];
    NSMenuItem *header = [NSMenuItem sectionHeaderWithTitle:existing.title ?: @""];
    [menu removeItemAtIndex:index];
    [menu insertItem:header atIndex:index];
    return header.isSectionHeader;
}

bool rion_dock_menu_promote_section_header(void *rawMenu, uintptr_t index) {
    return [NSThread isMainThread] && RionPromoteSectionHeader(rawMenu, index);
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

    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Dock Menu Test"];
    NSMenuItem *placeholder = [[NSMenuItem alloc] initWithTitle:@"Game Windows"
                                                         action:nil
                                                  keyEquivalent:@""];
    placeholder.enabled = NO;
    [menu addItem:placeholder];
    if (!RionPromoteSectionHeader((__bridge void *)menu, 0)) {
        return false;
    }
    return menu.itemArray.firstObject.isSectionHeader;
}

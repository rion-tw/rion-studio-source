use std::cell::RefCell;

use muda::{ContextMenu, MenuItem, PredefinedMenuItem, Submenu};

use crate::quick_menu::MenuEntry;

thread_local! {
    // Muda menus are main-thread, Rc-backed objects. Retaining the current root here keeps the
    // NSMenu alive for AppKit without making it Send or replacing Tauri's application delegate.
    static DOCK_MENU: RefCell<Option<Submenu>> = const { RefCell::new(None) };
}

unsafe extern "C" {
    fn rion_dock_menu_set_menu(menu: *mut std::ffi::c_void) -> bool;
    fn rion_dock_menu_promote_section_header(menu: *mut std::ffi::c_void, index: usize) -> bool;
    #[cfg(test)]
    fn rion_dock_menu_adapter_self_test() -> bool;
}

pub fn install(entries: &[MenuEntry]) -> Result<(), String> {
    let menu = Submenu::new("Rion Studio Quick Menu", true);
    let mut section_headers = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        append_entry(&menu, entry)?;
        if matches!(entry, MenuEntry::Header { .. }) {
            section_headers.push(index);
        }
    }

    let raw_menu = menu.ns_menu();
    for index in section_headers {
        // SAFETY: `menu` owns a live NSMenu and this function is called from Tauri's main thread.
        if !unsafe { rion_dock_menu_promote_section_header(raw_menu, index) } {
            return Err("Unable to create the macOS Dock menu section header.".to_owned());
        }
    }
    // SAFETY: the pointer belongs to `menu`; the native adapter retains it before this function
    // replaces the Rust-side owner below.
    if !unsafe { rion_dock_menu_set_menu(raw_menu) } {
        return Err(
            "Unable to install the macOS Dock menu without replacing the application delegate."
                .to_owned(),
        );
    }
    DOCK_MENU.with(|current| {
        current.replace(Some(menu));
    });
    Ok(())
}

fn append_entry(menu: &Submenu, entry: &MenuEntry) -> Result<(), String> {
    match entry {
        MenuEntry::Item { id, text, enabled } => {
            let item = MenuItem::with_id(id, text, *enabled, None);
            menu.append(&item).map_err(|error| error.to_string())
        }
        MenuEntry::Submenu { text, items } => {
            let submenu = Submenu::new(text, true);
            for item in items {
                append_entry(&submenu, item)?;
            }
            menu.append(&submenu).map_err(|error| error.to_string())
        }
        MenuEntry::Separator => {
            let separator = PredefinedMenuItem::separator();
            menu.append(&separator).map_err(|error| error.to_string())
        }
        MenuEntry::Header { text } => {
            let item = MenuItem::new(text, false, None);
            menu.append(&item).map_err(|error| error.to_string())
        }
    }
}

#[cfg(test)]
pub fn native_adapter_self_test() -> bool {
    // SAFETY: the native test owns all temporary Objective-C classes and menu objects it creates.
    unsafe { rion_dock_menu_adapter_self_test() }
}

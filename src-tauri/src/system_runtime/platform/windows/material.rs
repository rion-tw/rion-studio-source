#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsMicaMaterial {
    Mica,
    Opaque,
}

#[cfg(any(windows, test))]
fn windows_mica_material_for_version(major: u32, build: u32) -> WindowsMicaMaterial {
    if major > 10 || (major == 10 && build >= 22_000) {
        WindowsMicaMaterial::Mica
    } else {
        WindowsMicaMaterial::Opaque
    }
}

#[cfg(windows)]
#[repr(C)]
struct RtlOsVersionInfo {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform_id: u32,
    service_pack: [u16; 128],
}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn RtlGetVersion(version_information: *mut RtlOsVersionInfo) -> i32;
}

#[cfg(windows)]
fn windows_mica_material_for_current_system() -> WindowsMicaMaterial {
    let mut version = RtlOsVersionInfo {
        size: std::mem::size_of::<RtlOsVersionInfo>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform_id: 0,
        service_pack: [0; 128],
    };
    let status = unsafe { RtlGetVersion(std::ptr::addr_of_mut!(version)) };
    if status < 0 {
        return WindowsMicaMaterial::Opaque;
    }
    windows_mica_material_for_version(version.major, version.build)
}

#[cfg(windows)]
fn windows_mica_effects() -> tauri::utils::config::WindowEffectsConfig {
    tauri::window::EffectsBuilder::new()
        .effect(tauri::window::Effect::Mica)
        .build()
}

#[cfg(windows)]
pub(crate) fn apply_windows_mica_to_main_window(window: &tauri::WebviewWindow) -> bool {
    if windows_mica_material_for_current_system() != WindowsMicaMaterial::Mica {
        return false;
    }
    match window.set_effects(windows_mica_effects()) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("Windows Mica could not be applied to the main window: {error}");
            false
        }
    }
}

#[cfg(windows)]
fn build_windows_runtime_host_window(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
    width: f64,
    height: f64,
) -> tauri::Result<(tauri::Window, WindowsMicaMaterial)> {
    let build = |material: WindowsMicaMaterial| {
        let builder = tauri::window::WindowBuilder::new(app, label.to_owned())
            .title(title.to_owned())
            .inner_size(width, height)
            .min_inner_size(640.0, 480.0)
            .visible(false)
            .focused(false)
            .decorations(false)
            .shadow(true);
        let builder = if material == WindowsMicaMaterial::Mica {
            builder.transparent(true).effects(windows_mica_effects())
        } else {
            builder
        };
        builder.build()
    };

    if windows_mica_material_for_current_system() != WindowsMicaMaterial::Mica {
        return build(WindowsMicaMaterial::Opaque)
            .map(|window| (window, WindowsMicaMaterial::Opaque));
    }

    match build(WindowsMicaMaterial::Mica) {
        Ok(window) => Ok((window, WindowsMicaMaterial::Mica)),
        Err(error) => {
            eprintln!(
                "Windows Mica could not be applied to a game window; retrying with an opaque host: {error}"
            );
            build(WindowsMicaMaterial::Opaque)
                .map(|window| (window, WindowsMicaMaterial::Opaque))
        }
    }
}

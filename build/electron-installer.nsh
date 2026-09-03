!include "LogicLib.nsh"

; Tauri v22 currentUser used the identifier-derived manufacturer key and
; product-name uninstall key. Reusing that install-location key lets the
; Electron NSIS target replace the existing layout instead of creating a
; second copy under FOLDERID_UserProgramFiles.
!define RION_TAURI_V22_INSTALL_REGISTRY_KEY "Software\rionstudio\Rion Studio"
!define RION_TAURI_V22_UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rion Studio"
!define INSTALL_REGISTRY_KEY "${RION_TAURI_V22_INSTALL_REGISTRY_KEY}"
!define UNINSTALL_REGISTRY_KEY_2 "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}"

Var RionTauriV22InstallDirectory

!macro preInit
  !ifndef BUILD_UNINSTALLER
    SetRegView 32
    StrCpy $RionTauriV22InstallDirectory ""
    ReadRegStr $R8 HKCU "${RION_TAURI_V22_INSTALL_REGISTRY_KEY}" ""
    ReadRegStr $R7 HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}" "DisplayName"
    ReadRegStr $R6 HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}" "MainBinaryName"
    ReadRegStr $R5 HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}" "Publisher"
    ReadRegStr $R4 HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $R3 HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}" "DisplayIcon"
    ReadRegStr $R2 HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ReadRegStr $R1 HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    StrCpy $R0 "$\"$R8$\""
    ${If} $R8 != ""
    ${AndIf} $R7 == "Rion Studio"
    ${AndIf} $R6 == "rion-tauri.exe"
    ${AndIf} $R5 == "rionstudio"
    ${AndIf} $R4 == $R0
    ${AndIf} $R3 == "$\"$R8\rion-tauri.exe$\""
    ${AndIf} $R2 == "$\"$R8\uninstall.exe$\""
    ${AndIf} $R1 != ""
    ${AndIf} ${FileExists} "$R8\rion-tauri.exe"
    ${AndIf} ${FileExists} "$R8\uninstall.exe"
      StrCpy $RionTauriV22InstallDirectory $R8
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$R8"
      SetRegView 64
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$R8"
      SetRegView 32
    ${EndIf}
  !endif
!macroend

!macro customInstall
  ${If} $RionTauriV22InstallDirectory != ""
  ${AndIf} $RionTauriV22InstallDirectory == $INSTDIR
    ; The exact published v22 bundle contains these two install-root files.
    ; Replace them only after the Electron payload has landed, and fail closed
    ; if the legacy layout or registry identity cannot be retired. AppData and
    ; unrelated files are intentionally outside this migration.
    ${IfNot} ${FileExists} "$INSTDIR\${PRODUCT_FILENAME}.exe"
      Goto rion_tauri_v22_migration_failed
    ${EndIf}
    ${IfNot} ${FileExists} "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe"
      Goto rion_tauri_v22_migration_failed
    ${EndIf}
    ClearErrors
    Delete "$INSTDIR\rion-tauri.exe"
    IfErrors rion_tauri_v22_migration_failed
    ${If} ${FileExists} "$INSTDIR\rion-tauri.exe"
      Goto rion_tauri_v22_migration_failed
    ${EndIf}
    ClearErrors
    Delete "$INSTDIR\uninstall.exe"
    IfErrors rion_tauri_v22_migration_failed
    ${If} ${FileExists} "$INSTDIR\uninstall.exe"
      Goto rion_tauri_v22_migration_failed
    ${EndIf}
    SetRegView 32
    ClearErrors
    DeleteRegKey HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}"
    IfErrors rion_tauri_v22_migration_failed
    ClearErrors
    DeleteRegKey HKCU "${RION_TAURI_V22_INSTALL_REGISTRY_KEY}"
    IfErrors rion_tauri_v22_migration_failed
    ReadRegStr $R0 HKCU "${RION_TAURI_V22_INSTALL_REGISTRY_KEY}" ""
    ReadRegStr $R1 HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}" "DisplayName"
    ${If} $R0 != ""
    ${OrIf} $R1 != ""
      Goto rion_tauri_v22_migration_failed
    ${EndIf}
    SetRegView 64
    DeleteRegKey HKCU "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}"
    ClearErrors
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "" "$INSTDIR"
    IfErrors rion_tauri_v22_migration_failed
    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" ""
    ${If} $R0 != $INSTDIR
      Goto rion_tauri_v22_migration_failed
    ${EndIf}
    Goto rion_tauri_v22_migration_complete

    rion_tauri_v22_migration_failed:
      SetErrorLevel 1
      Quit
    rion_tauri_v22_migration_complete:
  ${EndIf}
!macroend

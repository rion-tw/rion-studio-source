!include "FileFunc.nsh"

!macro NSIS_HOOK_PREINSTALL
  ; Legacy desktop-shell updater arguments (/S, /D, --updated, --force-run) are
  ; intentionally tolerated by NSIS. Tauri invokes this hook after its running-app
  ; check. Clean only known application-directory residue when the old app.asar is
  ; present; shared AppData, SQLite, role stores, and browser data are never touched.
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    Delete "$INSTDIR\resources\app.asar"
    RMDir /r "$INSTDIR\resources\app.asar.unpacked"
    Delete "$INSTDIR\resources\electron.asar"
    Delete "$INSTDIR\resources\default_app.asar"
    Delete "$INSTDIR\resources\elevate.exe"
    Delete "$INSTDIR\resources\app-update.yml"
    Delete "$INSTDIR\resources\icon.png"
    Delete "$INSTDIR\resources\icon.ico"
    Delete "$INSTDIR\resources\native\rion-core.node"
    Delete "$INSTDIR\resources\native\rion-runtime-tabs.node"
    Delete "$INSTDIR\resources\native\rion-webview2.node"
    RMDir "$INSTDIR\resources\native"
    Delete "$INSTDIR\resources\legal\LICENSE.electron.txt"
    Delete "$INSTDIR\resources\legal\LICENSES.chromium.html"
    Delete "$INSTDIR\Uninstall Rion Studio.exe"
    Delete "$INSTDIR\LICENSE.electron.txt"
    Delete "$INSTDIR\LICENSES.chromium.html"
    Delete "$INSTDIR\chrome_100_percent.pak"
    Delete "$INSTDIR\chrome_200_percent.pak"
    Delete "$INSTDIR\d3dcompiler_47.dll"
    Delete "$INSTDIR\ffmpeg.dll"
    Delete "$INSTDIR\icudtl.dat"
    Delete "$INSTDIR\libEGL.dll"
    Delete "$INSTDIR\libGLESv2.dll"
    Delete "$INSTDIR\resources.pak"
    Delete "$INSTDIR\snapshot_blob.bin"
    Delete "$INSTDIR\v8_context_snapshot.bin"
    Delete "$INSTDIR\vk_swiftshader.dll"
    Delete "$INSTDIR\vk_swiftshader_icd.json"
    Delete "$INSTDIR\vulkan-1.dll"
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\swiftshader"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The retired automatic updater adds --force-run after a successful silent
  ; install. Preserve that behavior without treating --updated as an install path.
  Push $R0
  Push $R1
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  IfErrors rion_no_force_run
  Exec '"$INSTDIR\rion-tauri.exe" --updated'
  rion_no_force_run:
  Pop $R1
  Pop $R0
!macroend

{
  "targets": [
    {
      "target_name": "rion-webview2",
      "sources": ["addon.cc"],
      "include_dirs": [
        "<!(node -p \"process.env.RION_WEBVIEW2_SDK_DIR + '/build/native/include'\")"
      ],
      "defines": [
        "NOMINMAX",
        "UNICODE",
        "_UNICODE",
        "WIN32_LEAN_AND_MEAN"
      ],
      "libraries": [
        "<!(node -p \"process.env.RION_WEBVIEW2_SDK_DIR + '/build/native/x64/WebView2LoaderStatic.lib'\")",
        "ole32.lib",
        "shlwapi.lib",
        "user32.lib",
        "version.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++20", "/permissive-"],
          "ExceptionHandling": 1,
          "WarningLevel": 4
        }
      }
    }
  ]
}

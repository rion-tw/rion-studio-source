{
  "targets": [
    {
      "target_name": "rion-runtime-tabs",
      "sources": [
        "addon.mm",
        "RionRuntimeTabsController.mm",
        "RionSystemWebViewSurface.mm"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "OTHER_LDFLAGS": [
          "-framework AppKit",
          "-framework Network",
          "-framework WebKit"
        ]
      }
    },
    {
      "target_name": "rion-runtime-tabs-tests",
      "type": "executable",
      "sources": [
        "../../../src-tauri/native/macos/RionWKWebViewInput.m",
        "RionRuntimeTabsController.mm",
        "RionSystemWebViewSurface.mm",
        "RionRuntimeTabsControllerTests.mm"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "OTHER_LDFLAGS": [
          "-framework AppKit",
          "-framework Network",
          "-framework WebKit"
        ]
      }
    }
  ]
}

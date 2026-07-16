{
  "targets": [
    {
      "target_name": "rion-runtime-tabs",
      "sources": [
        "addon.mm",
        "RionRuntimeTabsController.mm"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_LDFLAGS": [
          "-framework AppKit"
        ]
      }
    },
    {
      "target_name": "rion-runtime-tabs-tests",
      "type": "executable",
      "sources": [
        "RionRuntimeTabsController.mm",
        "RionRuntimeTabsControllerTests.mm"
      ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_LDFLAGS": [
          "-framework AppKit"
        ]
      }
    }
  ]
}

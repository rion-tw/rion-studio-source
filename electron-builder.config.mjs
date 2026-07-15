import process from "node:process";

const DEFAULT_RELEASE_REPOSITORY = "rion-tw/rion-studio";
const [githubOwner, githubRepo] = (
  process.env.RION_STUDIO_RELEASE_REPOSITORY ?? DEFAULT_RELEASE_REPOSITORY
).split("/");

/**
 * @type {import("electron-builder").Configuration}
 */
const config = {
  appId: "com.rionstudio.launcher",
  productName: "Rion Studio",
  artifactName: "Rion.Studio-${os}.${ext}",
  compression: "maximum",
  directories: {
    output: "release/${version}"
  },
  files: ["out", "package.json"],
  extraResources: [
    {
      from: "build/icon.png",
      to: "icon.png"
    },
    {
      from: "docs/legal",
      to: "legal"
    },
    {
      from: "node_modules/electron/dist/LICENSE",
      to: "legal/LICENSE.electron.txt"
    },
    {
      from: "node_modules/electron/dist/LICENSES.chromium.html",
      to: "legal/LICENSES.chromium.html"
    }
  ],
  publish: [
    {
      provider: "github",
      owner: githubOwner,
      repo: githubRepo,
      releaseType: "release"
    }
  ],
  electronUpdaterCompatibility: ">=2.16",
  electronLanguages: ["en", "en-US", "zh_TW", "zh-TW", "zh_CN", "zh-CN", "ja"],
  mac: {
    icon: "build/icon.icns",
    category: "public.app-category.utilities",
    identity: "-",
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    notarize: false,
    sign: "build/signMacAdHoc.mjs",
    target: ["dmg", "zip"]
  },
  dmg: {
    title: "${productName} ${version}",
    backgroundColor: "#f5f5f7",
    iconSize: 80,
    iconTextSize: 12,
    window: {
      width: 540,
      height: 380
    },
    contents: [
      {
        x: 130,
        y: 185,
        type: "file"
      },
      {
        x: 410,
        y: 185,
        type: "link",
        path: "/Applications"
      },
      {
        x: 270,
        y: 310,
        type: "file",
        path: "build/Install Help.txt"
      }
    ]
  },
  win: {
    icon: "build/icon.ico",
    target: ["nsis"],
    extraResources: [
      {
        from: "build/native/win32-x64/rion-window-frame-helper.exe",
        to: "native/rion-window-frame-helper.exe"
      }
    ],
    signExts: ["rion-window-frame-helper.exe"]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  }
};

export default config;

import process from "node:process";

const [githubOwner, githubRepo] = (process.env.GITHUB_REPOSITORY ?? "rion-tw/rion-studio").split("/");

/**
 * @type {import("electron-builder").Configuration}
 */
const config = {
  appId: "com.rionstudio.launcher",
  productName: "Rion Studio",
  artifactName: "Rion.Studio-${os}.${ext}",
  directories: {
    output: "release/${version}"
  },
  files: [
    "out",
    "package.json",
    "!node_modules/playwright-core/.local-browsers/**",
    "!**/node_modules/playwright-core/.local-browsers/**"
  ],
  extraResources: [
    {
      from: "build/icon.png",
      to: "icon.png"
    },
    {
      from: "resources/cdn-compat-extension",
      to: "cdn-compat-extension"
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
  afterPack: "build/afterPack.mjs",
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
    target: ["nsis"]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true
  }
};

export default config;

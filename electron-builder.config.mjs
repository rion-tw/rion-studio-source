import process from "node:process";

const [githubOwner, githubRepo] = (process.env.GITHUB_REPOSITORY ?? "rion-tw/rion-studio").split("/");

/**
 * @type {import("electron-builder").Configuration}
 */
const config = {
  appId: "com.rionstudio.launcher",
  productName: "Rion Studio",
  artifactName: "${productName}-${os}.${ext}",
  directories: {
    output: "release/${version}"
  },
  files: ["out", "package.json"],
  asarUnpack: ["node_modules/playwright-core/.local-browsers/**"],
  extraResources: [
    {
      from: "build/icon.png",
      to: "icon.png"
    },
    {
      from: "build/icon.icns",
      to: "icon.icns"
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
  mac: {
    icon: "build/icon.icns",
    category: "public.app-category.utilities",
    target: ["dmg", "zip"]
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

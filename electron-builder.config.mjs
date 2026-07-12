import process from "node:process";

const [githubOwner, githubRepo] = (process.env.GITHUB_REPOSITORY ?? "rion-studio/rion-studio").split("/");

/**
 * @type {import("electron-builder").Configuration}
 */
const config = {
  appId: "com.rionstudio.launcher",
  productName: "Rion Studio",
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
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
      repo: githubRepo
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

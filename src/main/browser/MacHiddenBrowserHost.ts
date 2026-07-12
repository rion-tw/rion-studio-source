import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

import { configurePlaywrightBrowsersPath } from "./BrowserManager";

const HELPER_APP_NAME = "Rion Studio Browser";
const HELPER_BUNDLE_ID = "com.rionstudio.launcher.browser";
const HELPER_EXECUTABLE_NAME = HELPER_APP_NAME;
const HELPER_PATCH_VERSION = 7;
const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface MacHiddenBrowserHostConfig {
  platform?: NodeJS.Platform;
  getChromiumExecutablePath?: () => Promise<string>;
  copyApp?: (sourceAppPath: string, targetAppPath: string) => Promise<void>;
  patchInfoPlist?: (plistPath: string) => Promise<void>;
  patchLocalizedInfoPlistStrings?: (appPath: string) => Promise<void>;
  appIconPath?: string;
  replaceAppIcon?: (appPath: string) => Promise<void>;
  renameExecutable?: (appPath: string, sourceExecutableName: string, targetExecutableName: string) => Promise<void>;
  signApp?: (appPath: string, bundleId: string) => Promise<void>;
  registerApp?: (appPath: string) => Promise<void>;
  logger?: Pick<Console, "warn">;
}

interface HostMetadata {
  sourceAppPath: string;
  sourceExecutableName: string;
  targetExecutableName: string;
  patchVersion: number;
}

export class MacHiddenBrowserHost {
  private readonly platform: NodeJS.Platform;
  private readonly getChromiumExecutablePath: () => Promise<string>;
  private readonly copyApp: (sourceAppPath: string, targetAppPath: string) => Promise<void>;
  private readonly patchInfoPlist: (plistPath: string) => Promise<void>;
  private readonly patchLocalizedInfoPlistStrings: (appPath: string) => Promise<void>;
  private readonly replaceAppIcon: (appPath: string) => Promise<void>;
  private readonly renameExecutable: (
    appPath: string,
    sourceExecutableName: string,
    targetExecutableName: string
  ) => Promise<void>;
  private readonly signApp: (appPath: string, bundleId: string) => Promise<void>;
  private readonly registerApp: (appPath: string) => Promise<void>;
  private readonly logger: Pick<Console, "warn">;
  private cachedExecutablePath: string | undefined;

  constructor(
    private readonly userDataDir: string,
    config: MacHiddenBrowserHostConfig = {}
  ) {
    this.platform = config.platform ?? process.platform;
    this.getChromiumExecutablePath = config.getChromiumExecutablePath ?? getPlaywrightChromiumExecutablePath;
    this.copyApp = config.copyApp ?? copyMacAppBundle;
    this.patchInfoPlist =
      config.patchInfoPlist ??
      ((plistPath) =>
        patchMacAppInfoPlist(plistPath, {
          CFBundleDisplayName: { type: "string", value: HELPER_APP_NAME },
          CFBundleExecutable: { type: "string", value: HELPER_EXECUTABLE_NAME },
          CFBundleIconFile: { type: "string", value: "app.icns" },
          CFBundleIconName: { type: "remove" },
          CFBundleIdentifier: { type: "string", value: HELPER_BUNDLE_ID },
          CFBundleName: { type: "string", value: HELPER_APP_NAME },
          LSHasLocalizedDisplayName: { type: "remove" }
        }));
    this.patchLocalizedInfoPlistStrings = config.patchLocalizedInfoPlistStrings ?? patchMacAppLocalizedInfoPlistStrings;
    this.replaceAppIcon =
      config.replaceAppIcon ??
      ((appPath) => replaceMacAppIcon(appPath, config.appIconPath ? [config.appIconPath] : getDefaultHelperIconPaths()));
    this.renameExecutable = config.renameExecutable ?? renameMacAppExecutable;
    this.signApp = config.signApp ?? signMacAppBundle;
    this.registerApp = config.registerApp ?? registerMacAppBundle;
    this.logger = config.logger ?? console;
  }

  async resolveExecutablePath(): Promise<string | undefined> {
    if (this.platform !== "darwin") {
      return undefined;
    }

    try {
      const sourceExecutablePath = await this.getChromiumExecutablePath();
      const sourceAppPath = getMacAppBundlePathFromExecutable(sourceExecutablePath);

      if (!sourceAppPath) {
        throw new Error(`Chromium executable is not inside a macOS app bundle: ${sourceExecutablePath}`);
      }

      const sourceExecutableName = basename(sourceExecutablePath);
      const targetExecutableName = HELPER_EXECUTABLE_NAME;
      const targetRoot = join(this.userDataDir, "browser-host");
      const targetAppPath = join(targetRoot, `${HELPER_APP_NAME}.app`);
      const targetExecutablePath = join(targetAppPath, "Contents", "MacOS", targetExecutableName);
      const metadataPath = join(targetRoot, "source.json");
      const metadata: HostMetadata = {
        sourceAppPath,
        sourceExecutableName,
        targetExecutableName,
        patchVersion: HELPER_PATCH_VERSION
      };

      if (
        this.cachedExecutablePath === targetExecutablePath &&
        (await isPrepared(targetExecutablePath, metadataPath, metadata))
      ) {
        return this.cachedExecutablePath;
      }

      if (!(await isPrepared(targetExecutablePath, metadataPath, metadata))) {
        await mkdir(targetRoot, { recursive: true });
        await this.copyApp(sourceAppPath, targetAppPath);
      }

      await this.renameExecutable(targetAppPath, sourceExecutableName, targetExecutableName);
      await this.patchInfoPlist(join(targetAppPath, "Contents", "Info.plist"));
      await this.patchLocalizedInfoPlistStrings(targetAppPath);
      await this.replaceAppIcon(targetAppPath);
      await this.signApp(targetAppPath, HELPER_BUNDLE_ID);
      await this.registerApp(targetAppPath).catch((error) => {
        this.logger.warn("Unable to register Rion Studio browser helper with LaunchServices.", error);
      });
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      this.cachedExecutablePath = targetExecutablePath;
      return targetExecutablePath;
    } catch (error) {
      this.logger.warn("Unable to prepare hidden Rion Studio browser helper.", error);
      return undefined;
    }
  }
}

export function getMacAppBundlePathFromExecutable(executablePath: string): string | undefined {
  const marker = ".app/Contents/MacOS/";
  const markerIndex = executablePath.indexOf(marker);

  if (markerIndex === -1) {
    return undefined;
  }

  return executablePath.slice(0, markerIndex + ".app".length);
}

type PlistValue = { type: "string"; value: string } | { type: "boolean"; value: boolean } | { type: "remove" };

export async function patchMacAppInfoPlist(plistPath: string, values: Record<string, PlistValue>): Promise<void> {
  const raw = await readFile(plistPath);
  const text = raw.toString("utf8");

  if (looksLikeXmlPlist(text)) {
    await writeFile(plistPath, patchXmlInfoPlist(text, values), "utf8");
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    if (value.type === "remove") {
      await runCommand("/usr/bin/plutil", ["-remove", key, plistPath]).catch(() => undefined);
    } else if (value.type === "boolean") {
      await runCommand("/usr/bin/plutil", ["-replace", key, "-bool", value.value ? "YES" : "NO", plistPath]);
    } else {
      await runCommand("/usr/bin/plutil", ["-replace", key, "-string", value.value, plistPath]);
    }
  }
}

export function patchXmlInfoPlist(text: string, values: Record<string, PlistValue>): string {
  const rootDict = findRootDictRange(text);
  let rootBody = text.slice(rootDict.contentStart, rootDict.contentEnd);

  for (const [key, value] of Object.entries(values)) {
    rootBody = value.type === "remove" ? removeRootXmlPlistValue(rootBody, key) : setRootXmlPlistValue(rootBody, key, value);
  }

  return `${text.slice(0, rootDict.contentStart)}${rootBody}${text.slice(rootDict.contentEnd)}`;
}

async function getPlaywrightChromiumExecutablePath(): Promise<string> {
  configurePlaywrightBrowsersPath();
  const { chromium } = await import("playwright");
  return chromium.executablePath();
}

async function copyMacAppBundle(sourceAppPath: string, targetAppPath: string): Promise<void> {
  await rm(targetAppPath, { force: true, recursive: true });
  await cp(sourceAppPath, targetAppPath, { recursive: true, verbatimSymlinks: true });
}

async function renameMacAppExecutable(
  appPath: string,
  sourceExecutableName: string,
  targetExecutableName: string
): Promise<void> {
  if (sourceExecutableName === targetExecutableName) {
    return;
  }

  const macOsPath = join(appPath, "Contents", "MacOS");
  const sourceExecutablePath = join(macOsPath, sourceExecutableName);
  const targetExecutablePath = join(macOsPath, targetExecutableName);

  if (await pathExists(targetExecutablePath)) {
    return;
  }

  if (!(await pathExists(sourceExecutablePath))) {
    throw new Error(`Unable to find macOS app executable to rename: ${sourceExecutablePath}`);
  }

  await rename(sourceExecutablePath, targetExecutablePath);
}

async function patchMacAppLocalizedInfoPlistStrings(appPath: string): Promise<void> {
  const resourcesPath = join(appPath, "Contents", "Resources");
  const entries = await readdir(resourcesPath, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lproj"))
      .map(async (entry) => {
        const stringsPath = join(resourcesPath, entry.name, "InfoPlist.strings");

        try {
          const text = await readFile(stringsPath, "utf8");
          await writeFile(
            stringsPath,
            patchAppleStringsFile(text, {
              CFBundleDisplayName: HELPER_APP_NAME,
              CFBundleGetInfoString: HELPER_APP_NAME,
              CFBundleName: HELPER_APP_NAME
            }),
            "utf8"
          );
        } catch {
          // Chromium may omit some locale files in future bundled builds.
        }
      })
  );
}

async function replaceMacAppIcon(appPath: string, iconPaths: string[]): Promise<void> {
  const iconPath = await findExistingPath(iconPaths);

  if (!iconPath) {
    return;
  }

  const resourcesPath = join(appPath, "Contents", "Resources");
  await mkdir(resourcesPath, { recursive: true });
  await copyFile(iconPath, join(resourcesPath, "app.icns"));
}

function getDefaultHelperIconPaths(): string[] {
  if (process.versions.electron && !process.defaultApp) {
    return [join(process.resourcesPath, "icon.icns")];
  }

  return [
    join(__dirname, "../../build/icon.icns"),
    join(__dirname, "../../../build/icon.icns")
  ];
}

async function findExistingPath(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathExists(path)) {
      return path;
    }
  }

  return undefined;
}

function patchAppleStringsFile(text: string, values: Record<string, string>): string {
  let output = text;

  for (const [key, value] of Object.entries(values)) {
    output = setAppleStringsValue(output, key, value);
  }

  return output.endsWith("\n") ? output : `${output}\n`;
}

function setAppleStringsValue(text: string, key: string, value: string): string {
  const rendered = `${key} = "${escapeAppleStringsValue(value)}";`;
  const escapedKey = escapeRegExp(key);
  const pattern = new RegExp(`^\\s*(?:"${escapedKey}"|${escapedKey})\\s*=\\s*"(?:(?:\\\\.)|[^"\\\\])*";\\s*$`, "m");

  if (pattern.test(text)) {
    return text.replace(pattern, rendered);
  }

  const separator = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  return `${text}${separator}${rendered}\n`;
}

async function isPrepared(executablePath: string, metadataPath: string, metadata: HostMetadata): Promise<boolean> {
  if (!(await pathExists(executablePath))) {
    return false;
  }

  try {
    const raw = await readFile(metadataPath, "utf8");
    return JSON.stringify(JSON.parse(raw)) === JSON.stringify(metadata);
  } catch {
    return false;
  }
}

async function signMacAppBundle(appPath: string, bundleId: string): Promise<void> {
  await runCommand("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--identifier", bundleId, appPath]);
}

async function registerMacAppBundle(appPath: string): Promise<void> {
  await runCommand(LSREGISTER_PATH, ["-f", appPath]);
}

function looksLikeXmlPlist(text: string): boolean {
  return text.includes("<plist") && text.includes("<dict>");
}

interface XmlDictRange {
  contentStart: number;
  contentEnd: number;
}

function findRootDictRange(text: string): XmlDictRange {
  const plistIndex = text.search(/<plist(?:\s[^>]*)?>/);

  if (plistIndex === -1) {
    throw new Error("Info.plist XML does not contain a plist root.");
  }

  const firstDictMatch = /<dict(?:\s[^>]*)?>/g;
  firstDictMatch.lastIndex = plistIndex;
  const match = firstDictMatch.exec(text);

  if (!match) {
    throw new Error("Info.plist XML does not contain a root dictionary.");
  }

  const rootOpenStart = match.index;
  const rootOpenEnd = firstDictMatch.lastIndex;
  const tagPattern = /<\/?dict(?:\s[^>]*)?>/g;
  tagPattern.lastIndex = rootOpenEnd;
  let depth = 1;

  for (let tagMatch = tagPattern.exec(text); tagMatch; tagMatch = tagPattern.exec(text)) {
    const tag = tagMatch[0];

    if (tag.startsWith("</")) {
      depth -= 1;

      if (depth === 0) {
        return {
          contentStart: rootOpenEnd,
          contentEnd: tagMatch.index
        };
      }
    } else if (!tag.endsWith("/>")) {
      depth += 1;
    }
  }

  throw new Error(`Info.plist XML root dictionary starting at ${rootOpenStart} is not closed.`);
}

function setRootXmlPlistValue(text: string, key: string, value: PlistValue): string {
  const replacement = `<key>${escapeXml(key)}</key>\n${renderXmlPlistValue(value)}`;
  const existing = findDirectRootKeyValueRange(text, key);

  if (existing) {
    return `${text.slice(0, existing.start)}${replacement}${text.slice(existing.end)}`;
  }

  return `${text}${getRootInsertIndent(text)}${replacement}\n`;
}

function removeRootXmlPlistValue(text: string, key: string): string {
  const existing = findDirectRootKeyValueRange(text, key);

  if (!existing) {
    return text;
  }

  const start = findLineStart(text, existing.start);
  const end = text[existing.end] === "\n" ? existing.end + 1 : existing.end;
  return `${text.slice(0, start)}${text.slice(end)}`;
}

interface XmlRange {
  start: number;
  end: number;
}

function findDirectRootKeyValueRange(text: string, key: string): XmlRange | undefined {
  const tagPattern = /<key>[\s\S]*?<\/key>|<\/?(?:dict|array)(?:\s[^>]*)?>/g;
  let depth = 0;

  for (let match = tagPattern.exec(text); match; match = tagPattern.exec(text)) {
    const tag = match[0];

    if (tag.startsWith("<key>")) {
      if (depth === 0 && tag === `<key>${escapeXml(key)}</key>`) {
        return {
          start: match.index,
          end: findPlistValueEnd(text, tagPattern.lastIndex)
        };
      }

      continue;
    }

    if (tag.startsWith("</")) {
      depth = Math.max(0, depth - 1);
    } else if (!tag.endsWith("/>")) {
      depth += 1;
    }
  }

  return undefined;
}

function findPlistValueEnd(text: string, startIndex: number): number {
  const valueStart = skipWhitespace(text, startIndex);
  const valueTag = /^<(string|integer|real|date|data)>[\s\S]*?<\/\1>|^<(?:true|false)\s*\/>/u.exec(text.slice(valueStart));

  if (valueTag) {
    return valueStart + valueTag[0].length;
  }

  if (text.startsWith("<dict", valueStart)) {
    return findContainerEnd(text, valueStart, "dict");
  }

  if (text.startsWith("<array", valueStart)) {
    return findContainerEnd(text, valueStart, "array");
  }

  throw new Error("Info.plist XML key is missing a value.");
}

function findContainerEnd(text: string, startIndex: number, tagName: "array" | "dict"): number {
  const tagPattern = new RegExp(`</?${tagName}(?:\\s[^>]*)?>`, "g");
  tagPattern.lastIndex = startIndex;
  let depth = 0;

  for (let match = tagPattern.exec(text); match; match = tagPattern.exec(text)) {
    const tag = match[0];

    if (tag.startsWith("</")) {
      depth -= 1;

      if (depth === 0) {
        return tagPattern.lastIndex;
      }
    } else if (tag.endsWith("/>")) {
      return tagPattern.lastIndex;
    } else {
      depth += 1;
    }
  }

  throw new Error(`Info.plist XML ${tagName} value is not closed.`);
}

function skipWhitespace(text: string, startIndex: number): number {
  let index = startIndex;

  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }

  return index;
}

function findLineStart(text: string, index: number): number {
  const lineStart = text.lastIndexOf("\n", index - 1);
  return lineStart === -1 ? 0 : lineStart + 1;
}

function getRootInsertIndent(text: string): string {
  const match = /\n([ \t]*)<key>[^<]+<\/key>/.exec(text);

  if (match) {
    return `\n${match[1]}`;
  }

  return "\n  ";
}

function renderXmlPlistValue(value: PlistValue): string {
  if (value.type === "remove") {
    throw new Error("Cannot render removed Info.plist value.");
  }

  if (value.type === "boolean") {
    return value.value ? "<true/>" : "<false/>";
  }

  return `<string>${escapeXml(value.value)}</string>`;
}

function escapeAppleStringsValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

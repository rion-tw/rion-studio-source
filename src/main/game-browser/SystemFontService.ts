import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  normalizeBrowserFontFamily
} from "../../shared/browserFonts";
import type { SystemFontFamily } from "../../shared/types";

const execFileAsync = promisify(execFile);

const FONT_QUERY_TIMEOUT_MS = 5_000;
const FONT_QUERY_MAX_BUFFER = 2 * 1024 * 1024;
const FALLBACK_FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Times",
  "Georgia",
  "Verdana",
  "Courier New",
  "Menlo",
  "Monaco",
  "PingFang TC",
  "PingFang SC",
  "Microsoft JhengHei",
  "Microsoft YaHei",
  "Noto Sans",
  "Noto Serif",
  "Noto Sans Math"
];

export interface SystemFontServiceOptions {
  execFile?: typeof execFileAsync;
  platform?: NodeJS.Platform;
}

export class SystemFontService {
  private readonly execFile: typeof execFileAsync;
  private readonly platform: NodeJS.Platform;
  private fontCache?: SystemFontFamily[];

  constructor(options: SystemFontServiceOptions = {}) {
    this.execFile = options.execFile ?? execFileAsync;
    this.platform = options.platform ?? process.platform;
  }

  async listFonts(): Promise<SystemFontFamily[]> {
    if (this.fontCache) {
      return this.fontCache;
    }

    const queriedFonts = await this.queryFonts().catch(() => []);
    this.fontCache = normalizeSystemFonts(queriedFonts.length > 0 ? queriedFonts : FALLBACK_FONT_FAMILIES);
    return this.fontCache;
  }

  private async queryFonts(): Promise<string[]> {
    if (this.platform === "darwin") {
      return this.queryMacFonts();
    }

    if (this.platform === "win32") {
      return this.queryWindowsFonts();
    }

    return this.queryLinuxFonts();
  }

  private async queryMacFonts(): Promise<string[]> {
    const { stdout } = await this.execFile("/usr/sbin/system_profiler", ["SPFontsDataType", "-json"], {
      maxBuffer: FONT_QUERY_MAX_BUFFER,
      timeout: FONT_QUERY_TIMEOUT_MS
    });
    const parsed = JSON.parse(stdout) as unknown;
    return collectMacFontNames(parsed);
  }

  private async queryWindowsFonts(): Promise<string[]> {
    const command = [
      "Add-Type -AssemblyName System.Drawing;",
      "(New-Object System.Drawing.Text.InstalledFontCollection).Families |",
      "ForEach-Object { $_.Name }"
    ].join(" ");
    const { stdout } = await this.execFile("powershell.exe", ["-NoProfile", "-Command", command], {
      maxBuffer: FONT_QUERY_MAX_BUFFER,
      timeout: FONT_QUERY_TIMEOUT_MS
    });

    return stdout.split(/\r?\n/);
  }

  private async queryLinuxFonts(): Promise<string[]> {
    const { stdout } = await this.execFile("fc-list", [":", "family"], {
      maxBuffer: FONT_QUERY_MAX_BUFFER,
      timeout: FONT_QUERY_TIMEOUT_MS
    });

    return stdout
      .split(/\r?\n/)
      .flatMap((line) => line.split(","));
  }
}

export function normalizeSystemFonts(values: string[]): SystemFontFamily[] {
  const seen = new Set<string>();
  const fonts: SystemFontFamily[] = [];

  for (const value of values) {
    const family = normalizeBrowserFontFamily(value);
    if (!family) {
      continue;
    }

    const key = family.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    fonts.push({ family, label: family });
  }

  return fonts.sort((a, b) => a.label.localeCompare(b.label));
}

function collectMacFontNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectMacFontNames);
  }

  if (!isRecord(value)) {
    return [];
  }

  const names: string[] = [];
  if (typeof value._name === "string") {
    names.push(value._name);
  }

  if (typeof value.family === "string") {
    names.push(value.family);
  }

  return [...names, ...Object.values(value).flatMap(collectMacFontNames)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { existsSync, readFileSync as readFileFromDisk, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sourceExtensions = ["", ".ts", ".tsx", ".js", ".jsx", ".rs", ".m", ".mm"];

function resolveSourceReference(parent: string, reference: string): string | undefined {
  const base = path.resolve(path.dirname(parent), reference);
  for (const extension of sourceExtensions) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const extension of [".ts", ".tsx", ".js", ".jsx", ".rs"]) {
    const candidate = path.join(base, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function localReferences(source: string): string[] {
  const matches = [
    ...source.matchAll(/include!\(\s*"([^"]+)"\s*\)/g),
    ...source.matchAll(/#include\s+"([^"]+)"/g),
    ...source.matchAll(/@source\s+"([^"]+)"/g),
    ...source.matchAll(/@import\s+["'](\.[^"']+)["']/g),
    ...source.matchAll(/(?:from\s+|import\(\s*)["'](\.[^"']+)["']/g)
  ];
  return matches
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((match) => match[1]);
}

function readRecursive(file: string, visited: Set<string>): string {
  const absolute = path.resolve(file);
  if (visited.has(absolute)) return "";
  visited.add(absolute);
  const source = readFileFromDisk(absolute, "utf8");
  const children = localReferences(source)
    .map((reference) => resolveSourceReference(absolute, reference))
    .filter((candidate): candidate is string => Boolean(candidate));
  return [source, ...children.map((child) => readRecursive(child, visited))].join("\n");
}

function inputPath(input: string | URL): string {
  return input instanceof URL ? fileURLToPath(input) : path.resolve(input);
}

export function readSourceTreeSync(input: string | URL, _encoding = "utf8"): string {
  return readRecursive(inputPath(input), new Set());
}

export async function readSourceTree(input: string | URL, encoding = "utf8"): Promise<string> {
  return readSourceTreeSync(input, encoding);
}

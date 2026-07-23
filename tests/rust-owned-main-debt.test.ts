import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { RUST_OWNED_MAIN_DEBT, type RustBoundaryDebt } from "./architecture/rustOwnedMainDebt";

const projectRoot = resolve(import.meta.dirname, "..");
const mainRoot = resolve(projectRoot, "src/main");
const prohibitedNodeModules = new Set([
  "node:child_process",
  "node:dgram",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:net",
  "node:os",
  "node:tls"
]);
const allowedNodeIoImports = new Set([
  // This adapter locates the AppKit addon it owns; it does not perform domain I/O.
  "src/main/browser/MacRuntimeTabsController.ts:node:fs"
]);
const allowedMapProperties = new Set([
  "src/main/core/ElectronEffectExecutor.ts:ElectronHandleRegistry.handles",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.displayHostByChromeWebContentsId",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.displayHosts",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.dividerByWebContentsId",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.roleHandles",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.tabHandles",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.workspaceTabHandleIds",
  "src/main/browser/EmbeddedRuntimeDiagnostics.ts:EmbeddedRuntimeDiagnostics.records",
  "src/main/games/GameCompatibilityManager.ts:GameCompatibilityManager.windows",
  "src/main/macros/MacroOverlayInjector.ts:MacroOverlayInjector.contentRoleIds",
  "src/main/startup/startupWindow.ts:RendererReadyGate.pendingByWebContentsId"
]);
const rustOwnedOrchestrationName = /^(?:withRoleOperation)$/;
const allowedNativeAppCoreMethods = new Set([
  "dispatchCoreEffectResults",
  "invoke",
  "matchCdnUrl",
  "shutdown",
  "subscribeCoreEvents"
]);

interface ParsedSource {
  file: string;
  source: ts.SourceFile;
}

describe("Rust-owned main-process debt manifest", () => {
  it("matches every Node filesystem, process, network, and host-sampling import", async () => {
    const sources = await readMainSources();
    const actual = sources.flatMap(({ file, source }) =>
      source.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
          return [];
        }
        const moduleName = statement.moduleSpecifier.text;
        const key = `${file}:${moduleName}`;
        return prohibitedNodeModules.has(moduleName) && !allowedNodeIoImports.has(key) ? [key] : [];
      })
    );

    expectDebtToMatch(actual, RUST_OWNED_MAIN_DEBT.nodeIoImports);
  });

  it("matches every production core interval", async () => {
    const sources = await readMainSources();
    const actual: string[] = [];

    for (const { file, source } of sources) {
      visit(source, (node) => {
        if (!ts.isCallExpression(node) || node.expression.getText(source) !== "setInterval") return;
        actual.push(`${file}:${findAssignmentName(node)}`);
      });
    }

    expectDebtToMatch(actual, RUST_OWNED_MAIN_DEBT.coreIntervals);
  });

  it("matches authoritative Map state outside approved Electron handle registries", async () => {
    const sources = await readMainSources();
    const actual: string[] = [];

    for (const { file, source } of sources) {
      visit(source, (node) => {
        if (!ts.isPropertyDeclaration(node) || !isMapInitializer(node.initializer)) return;
        const className = findContainingClassName(node);
        const propertyName = node.name.getText(source);
        const key = `${file}:${className}.${propertyName}`;
        if (!allowedMapProperties.has(key)) actual.push(key);
      });
    }

    expectDebtToMatch(actual, RUST_OWNED_MAIN_DEBT.authoritativeMaps);
  });

  it("matches Promise-tail scheduling state", async () => {
    const sources = await readMainSources();
    const actual: string[] = [];

    for (const { file, source } of sources) {
      visit(source, (node) => {
        if (!ts.isPropertyDeclaration(node) || !isPromiseResolve(node.initializer, source)) return;
        const propertyName = node.name.getText(source);
        if (!/(?:queue|tail)$/i.test(propertyName)) return;
        actual.push(`${file}:${findContainingClassName(node)}.${propertyName}`);
      });
    }

    expectDebtToMatch(actual, RUST_OWNED_MAIN_DEBT.promiseTails);
  });

  it("matches browser lifecycle methods that still orchestrate Rust-owned state", async () => {
    const sources = await Promise.all([
      readSource("src/main/browser/ElectronBrowserRuntime.ts")
    ]);
    const actual: string[] = [];

    for (const { file, source } of sources) {
      visit(source, (node) => {
        if (!ts.isMethodDeclaration(node)) return;
        const methodName = node.name.getText(source);
        if (!rustOwnedOrchestrationName.test(methodName)) return;
        actual.push(`${file}:${findContainingClassName(node)}.${methodName}`);
      });
    }

    expectDebtToMatch(actual, RUST_OWNED_MAIN_DEBT.orchestrationMethods);
  });

  it("matches every specialized NativeAppCore method", async () => {
    const { source } = await readSource("src/main/core/nativeCore.ts");
    const nativeInterface = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "NativeAppCore"
    );
    expect(nativeInterface).toBeDefined();

    const actual = (nativeInterface?.members ?? []).flatMap((member) => {
      if (!ts.isPropertySignature(member) || !member.name) return [];
      const name = member.name.getText(source);
      return allowedNativeAppCoreMethods.has(name) ? [] : [name];
    });
    expectDebtToMatch(actual, RUST_OWNED_MAIN_DEBT.specializedNapiMethods);
  });

  it("keeps authoritative domain contracts generated by Rust", async () => {
    const { source } = await readSource("src/shared/types.ts");
    const handwrittenDomainNames = new Set([
      "CreateGameInput",
      "CreateLaunchWorkspaceInput",
      "CreateMacroInput",
      "CreateRoleInput",
      "Game",
      "LaunchWorkspace",
      "Macro",
      "Role"
    ]);
    const actual = source.statements.flatMap((statement) => {
      if (!ts.isInterfaceDeclaration(statement)) return [];
      return handwrittenDomainNames.has(statement.name.text) ? [statement.name.text] : [];
    });

    expect(actual).toEqual([]);
  });
});

async function readMainSources(): Promise<ParsedSource[]> {
  const files = await collectTypeScriptFiles(mainRoot);
  return Promise.all(files.map((file) => readSource(relative(projectRoot, file))));
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat().sort();
}

async function readSource(file: string): Promise<ParsedSource> {
  const contents = await readFile(resolve(projectRoot, file), "utf8");
  return {
    file,
    source: ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  };
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}

function findContainingClassName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isClassDeclaration(current)) current = current.parent;
  return current?.name?.text ?? "<module>";
}

function findAssignmentName(node: ts.CallExpression): string {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) return parent.left.getText();
  if (ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (ts.isPropertyDeclaration(parent)) return parent.name.getText();
  return "<anonymous>";
}

function isMapInitializer(node: ts.Expression | undefined): boolean {
  if (!node || !ts.isNewExpression(node)) return false;
  const name = node.expression.getText();
  return name === "Map" || name === "WeakMap";
}

function isPromiseResolve(node: ts.Expression | undefined, source: ts.SourceFile): boolean {
  return Boolean(
    node
    && ts.isCallExpression(node)
    && node.expression.getText(source) === "Promise.resolve"
  );
}

function expectDebtToMatch(actual: string[], manifest: RustBoundaryDebt[]): void {
  expect([...new Set(actual)].sort()).toEqual(manifest.map(({ key }) => key).sort());
}

import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

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
  // The temporary Electron shell owns authenticated cross-shell activation forwarding.
  "src/main/shell/CrossShellActivation.ts:node:fs/promises",
  "src/main/shell/CrossShellActivation.ts:node:net",
  // This adapter locates the AppKit addon it owns; it does not perform domain I/O.
  "src/main/browser/MacRuntimeTabsController.ts:node:fs",
  // Native surface loaders only locate their packaged N-API addon.
  "src/main/browser/MacSystemWebViewSurface.ts:node:fs",
  "src/main/browser/SystemCompatibilitySurfaceFactory.ts:node:fs/promises",
  "src/main/updates/AppUpdatePreferencesStore.ts:node:fs/promises",
  "src/main/browser/WindowsWebView2Surface.ts:node:fs"
]);
const allowedMapProperties = new Set([
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.displayHostByChromeWebContentsId",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.displayHosts",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.engineDisplayHosts",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.dividerByWebContentsId",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.runtimeTabSwitchQueues",
  // Electron-only single-flight generation state; Rust still owns layout decisions.
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.hostLayoutStates",
  // Serialized presentation dedupe for native/runtime chrome sends, not domain state.
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.lastRuntimeChromeStateByDisplay",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.lastRuntimeChromeStateByHost",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.roleHandles",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.tabHandles",
  "src/main/browser/ElectronBrowserRuntime.ts:ElectronBrowserRuntime.workspaceTabHandleIds",
  // OS child-view handles only; Rust remains authoritative for runtime/domain state.
  "src/main/browser/SystemWebViewRuntimePool.ts:SystemWebViewRuntimePool.handles",
  "src/main/browser/SystemWebViewRuntimePool.ts:SystemWebViewRuntimePool.unsubscribe",
  "src/main/browser/EmbeddedRuntimeDiagnostics.ts:EmbeddedRuntimeDiagnostics.records",
  "src/main/games/GameCompatibilityManager.ts:GameCompatibilityManager.surfaces",
  "src/main/macros/MacroOverlayInjector.ts:MacroOverlayInjector.contentRoleIds",
  "src/main/startup/startupWindow.ts:RendererReadyGate.pendingByWebContentsId"
]);
const rustOwnedOrchestrationName = /^(?:withRoleOperation)$/;
const allowedNativeAppCoreMethods = new Set([
  "dispatchCoreEffectResults",
  "invoke",
  "shutdown",
  "subscribeCoreEvents"
]);

interface ParsedSource {
  file: string;
  source: ts.SourceFile;
}

describe("thin TypeScript main-process release boundary", () => {
  it("has no non-Electron Node filesystem, process, network, or host-sampling imports", async () => {
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

    expectUniqueEmpty(actual);
  });

  it("has no production core intervals", async () => {
    const sources = await readMainSources();
    const actual: string[] = [];

    for (const { file, source } of sources) {
      visit(source, (node) => {
        if (!ts.isCallExpression(node) || node.expression.getText(source) !== "setInterval") return;
        actual.push(`${file}:${findAssignmentName(node)}`);
      });
    }

    expectUniqueEmpty(actual);
  });

  it("has no authoritative Map state outside approved Electron handle registries", async () => {
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

    expectUniqueEmpty(actual);
  });

  it("has no Promise-tail scheduling state", async () => {
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

    expectUniqueEmpty(actual);
  });

  it("has no browser lifecycle methods that orchestrate Rust-owned state", async () => {
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

    expectUniqueEmpty(actual);
  });

  it("exposes only the release Node-API methods", async () => {
    const { source } = await readSource("src/main/core/nativeCore.ts");
    const nativeInterface = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "NativeAppCore"
    );
    expect(nativeInterface).toBeDefined();

    const actual = (nativeInterface?.members ?? []).flatMap((member) => {
      if (!ts.isPropertySignature(member) || !member.name) return [];
      return [member.name.getText(source)];
    });
    expect([...actual].sort()).toEqual([...allowedNativeAppCoreMethods].sort());
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

  it("does not retain legacy managers, fallbacks, or specialized addon calls", async () => {
    const sources = await readMainSources();
    const productionMain = sources.map(({ source }) => source.getFullText()).join("\n");
    const addon = (await readSource("crates/rion-node/src/lib.rs")).source.getFullText();

    for (const symbol of [
      "BrowserManager",
      "RustStateRepository",
      "RION_STUDIO_RUST_FALLBACK_SUBSYSTEMS",
      "dispatchBrowserResults",
      "invokeBrowserRuntime",
      "invokeExternalSession",
      "invokeResourceRuntime",
      "acquireOperationLease",
      "prepareEmbeddedKeyTransition",
      "waitForScheduler"
    ]) {
      expect(productionMain).not.toContain(symbol);
      expect(addon).not.toContain(symbol);
    }
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

function expectUniqueEmpty(actual: string[]): void {
  expect([...new Set(actual)].sort()).toEqual([]);
}

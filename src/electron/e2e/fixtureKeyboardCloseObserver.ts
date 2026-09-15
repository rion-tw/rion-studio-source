import type { WebFrameMain } from "electron";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ChromiumRoleSurfaceRegistry } from "../main/chromiumRoleSurfaceRegistry";
import type { FixtureKeyboardEvidence } from "./fixtureKeyboardEvidence";

/** Test-only readback at the existing closeRole boundary, before overlay retirement. */
export function installFixtureKeyboardCloseObserver(directory: string | undefined, origin: string | undefined): void {
  if (!directory || !isAbsolute(directory) || !origin) return;
  const expectedOrigin = new URL(origin).origin;
  const owners = new WeakMap<ChromiumRoleSurfaceRegistry, Map<string, {
    roleId: string; generation: number; tabId: string; fixtureRoleId: string;
    observation?: Promise<void>;
  }>>();
  const evidence: FixtureKeyboardEvidence[] = [];
  const registry = ChromiumRoleSurfaceRegistry.prototype;
  const create = registry.create, close = registry.closeRole;
  registry.create = function (input) {
    const url = new URL(input.url);
    if (url.origin === expectedOrigin && /^\/role\/chromium-cleanup-(tab|window|shutdown)$/u.test(url.pathname)) {
      const entries = owners.get(this) ?? new Map();
      entries.set(input.roleId, { roleId: input.roleId, generation: input.generation,
        tabId: input.tabId, fixtureRoleId: url.pathname.slice("/role/".length) });
      owners.set(this, entries);
    }
    return create.call(this, input);
  };
  registry.closeRole = function (roleId, generation) {
    const owner = owners.get(this)?.get(roleId);
    if (!owner || owner.generation !== generation) return close.call(this, roleId, generation);
    owner.observation ??= (async () => {
      const entry: FixtureKeyboardEvidence = { roleId, generation, tabId: owner.tabId,
        fixtureRoleId: owner.fixtureRoleId, status: "failed" };
      try {
        const before = this.currentTrustedInputFrame(roleId, generation);
        const frame = before.frame as WebFrameMain;
        const url = new URL(frame.url);
        if (url.origin !== expectedOrigin || url.pathname !== `/role/${owner.fixtureRoleId}`) {
          throw new Error("Terminal fixture frame changed origin or role");
        }
        entry.documentInstanceId = before.documentInstanceId;
        entry.frameToken = before.frameToken;
        const snapshot = await frame.executeJavaScript("window.__rionFixtureKeyboardSnapshot?.()", false) as FixtureKeyboardEvidence["snapshot"];
        const after = this.currentTrustedInputFrame(roleId, generation);
        if (after.frame !== before.frame || after.frameToken !== before.frameToken ||
            after.documentInstanceId !== before.documentInstanceId) {
          throw new Error("Terminal fixture document was replaced during readback");
        }
        if (!snapshot || snapshot.fixtureRoleId !== owner.fixtureRoleId ||
            typeof snapshot.documentToken !== "string" || !Array.isArray(snapshot.events) ||
            snapshot.events.length > 256) throw new Error("Terminal fixture journal is unavailable");
        entry.snapshot = snapshot;
        entry.status = "captured";
      } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
      evidence.push(entry);
      if (evidence.length > 128) evidence.shift();
      try {
        writeFileSync(join(directory, "electron-fixture-keyboard-terminal.json"), JSON.stringify(evidence, null, 2));
      } catch (error) { console.error("E2E consumer evidence could not be saved", error); }
    })();
    return owner.observation.then(() => close.call(this, roleId, generation));
  };
}

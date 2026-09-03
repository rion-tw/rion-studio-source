import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ChromiumGlobalWebSessionRegistry } from
  "../main/chromiumGlobalWebSessionRegistry";
import {
  readChromiumSessionSecurityPolicyJournal,
  type ChromiumSecuritySessionPort
} from "../main/chromiumSecurityPolicy";
import type { ElectronDesktopE2eWorkspaceWebInspection } from
  "./workspaceWebInspection";
import type { ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection } from
  "./workspaceWebSecurityPolicyInspection";

const owners = new Map<string, Readonly<{
  generation: number;
  session: ChromiumSecuritySessionPort;
}>>();
const observations: ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection[] = [];

let artifactDirectory: string | undefined;
let installed = false;

function writeObservations(): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  writeFileSync(
    join(artifactDirectory, "electron-workspace-web-security-policy.json"),
    `${JSON.stringify(observations, null, 2)}\n`
  );
}

/** Observes exact global-Web Session ownership without adding a control path. */
export function installWorkspaceWebSecurityPolicyObserver(
  outputDirectory: string | undefined
): void {
  if (installed) return;
  installed = true;
  artifactDirectory = outputDirectory;
  const sessions = ChromiumGlobalWebSessionRegistry.prototype;
  const originalAcquireSurface = sessions.acquireSurface;
  const originalReleaseSurface = sessions.releaseSurface;
  sessions.acquireSurface = function (surfaceId, generation, profile) {
    const lease = originalAcquireSurface.call(this, surfaceId, generation, profile);
    owners.set(surfaceId, Object.freeze({ generation, session: lease.session }));
    return lease;
  };
  sessions.releaseSurface = async function (lease) {
    const released = await originalReleaseSurface.call(this, lease);
    const owner = owners.get(lease.surfaceId);
    if (released && owner?.session === lease.session &&
        owner.generation === lease.surfaceGeneration) {
      owners.delete(lease.surfaceId);
    }
    return released;
  };
}

export function readWorkspaceWebSecurityPolicy(
  workspace: ElectronDesktopE2eWorkspaceWebInspection
): ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection {
  const owner = owners.get(workspace.web.surfaceId);
  if (!owner || owner.generation !== workspace.web.generation) {
    throw new Error(
      `Workspace Web ${workspace.windowId} has no exact live security-policy Session owner.`
    );
  }
  const journal = readChromiumSessionSecurityPolicyJournal(owner.session);
  if (!journal || journal.sessionStoragePath !== workspace.web.contentProfilePath ||
      journal.observations.some((observation) =>
        observation.kind === "will-download" && !observation.defaultPrevented
      )) {
    throw new Error(
      `Workspace Web ${workspace.windowId} lost its exact deny-policy Session journal.`
    );
  }
  const inspection = Object.freeze({
    contentProfilePath: workspace.web.contentProfilePath,
    generation: workspace.web.generation,
    observations: Object.freeze(journal.observations.map((observation) =>
      Object.freeze({ ...observation })
    )) as ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection["observations"],
    policyVersion: journal.policyVersion,
    sessionStoragePath: journal.sessionStoragePath,
    surfaceId: workspace.web.surfaceId,
    windowId: workspace.windowId
  } satisfies ElectronDesktopE2eWorkspaceWebSecurityPolicyInspection);
  const prior = observations.at(-1);
  if (JSON.stringify(prior) !== JSON.stringify(inspection)) observations.push(inspection);
  writeObservations();
  return inspection;
}

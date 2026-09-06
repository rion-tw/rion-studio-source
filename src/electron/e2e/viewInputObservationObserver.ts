import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ChromiumViewAttachmentCoordinator } from "../main/chromiumViewAttachmentCoordinator";
import type { ChromiumViewInputObservation } from "../main/chromiumViewInputSubmission";

type Resolver = Pick<ChromiumViewAttachmentCoordinator, "resolve">;

/** Captures the exact sample consumed by input admission, without another read. */
export function installElectronDesktopE2eViewInputObservationObserver(
  prototype: Resolver,
  artifactDirectory: string | undefined
): void {
  if (!artifactDirectory || !isAbsolute(artifactDirectory)) return;
  const output = join(artifactDirectory, "electron-view-input-observations.json");
  const records: Array<{ sequence: number; observation: ChromiumViewInputObservation }> = [];
  const original = prototype.resolve;
  let sequence = 0;
  let queued = false;
  prototype.resolve = function (roleId, generation) {
    const attachment = original.call(this, roleId, generation);
    if (!attachment) return attachment;
    return Object.freeze({ ...attachment, observe: () => {
      const observation = attachment.observe();
      records.push({ sequence: ++sequence, observation: {
        ...observation, identity: { ...observation.identity }, bounds: { ...observation.bounds }
      } });
      if (records.length > 256) records.shift();
      if (!queued) {
        queued = true;
        // Persist after the synchronous admission/submission stack, never before it.
        queueMicrotask(() => {
          queued = false;
          writeFileSync(output, `${JSON.stringify(records, null, 2)}\n`);
        });
      }
      return observation;
    } });
  };
}

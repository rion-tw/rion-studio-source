import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
const selectors = ["windowWillResize:toSize:", "constrainFrameRect:toScreen:",
  "setFrame:display:", "nextEventMatchingMask:untilDate:inMode:dequeue:"];

function methodWitness(snapshot) {
  const installation = snapshot.journal.records.at(-1)?.hookInstallation;
  if (!Array.isArray(installation) || installation.length < 4 || installation.length > 8 ||
      installation.some((entry) => !object(entry) || !selectors.includes(entry.selector) ||
        typeof entry.wrappedClass !== "string" || typeof entry.definingClass !== "string" ||
        !["installed", "unsupported", "error"].includes(entry.status) ||
        (entry.status === "installed" && (!entry.wrappedClass || !entry.definingClass)) ||
        (entry.status !== "installed" && (typeof entry.reason !== "string" || !entry.reason)))) {
    throw new Error("The native resize method hook installation evidence is missing or malformed");
  }
  if (installation.some((entry) => entry.status === "error")) {
    throw new Error("The native resize method hook installation failed");
  }
  if (selectors.some((selector) => !installation.some((entry) => entry.selector === selector))) {
    throw new Error("The native resize method hook installation omitted a selector");
  }
  // A method that AppKit never called is still valid evidence. Unsupported
  // shapes remain explicit; this check never invents a size proposal or event.
  const returned = snapshot.journal.records.filter((record) => record.reason === "method:return");
  return { windowId: snapshot.identity.logicalWindowId, installation,
    returned: Object.fromEntries(selectors.map((selector) => [selector,
      returned.filter((record) => record.method?.selector === selector).length])) };
}

/** A diagnostic channel proof, never a visible journey or release verdict. */
export function verifyAppKitResizeDiagnosticCarrier(value) {
  if (!object(value) || value.journalVersion !== 1 || value.nativeCapacity !== 128 ||
      value.ownerCapacity !== 32 || !natural(value.droppedOwners) ||
      value.captureErrors !== 0 || value.flushStage !== "will-quit" ||
      !Array.isArray(value.snapshots) || value.snapshots.length > 32) {
    throw new Error("The terminal native resize carrier is missing or malformed");
  }
  if (value.snapshots.some((snapshot) => !object(snapshot) || !object(snapshot.journal) ||
      !Array.isArray(snapshot.journal.records))) {
    throw new Error("The native resize carrier contains a malformed snapshot");
  }
  const populated = value.snapshots.filter((snapshot) =>
    object(snapshot) && object(snapshot.journal) &&
    Array.isArray(snapshot.journal.records) && snapshot.journal.records.length > 0);
  if (!populated.length) throw new Error("The native resize carrier contains no native records");
  for (const snapshot of populated) {
    const { identity, callbackIdentity, journal } = snapshot;
    if (!object(identity) || !object(callbackIdentity) ||
        typeof identity.logicalWindowId !== "string" || !identity.logicalWindowId ||
        typeof identity.launchGeneration !== "string" || !identity.launchGeneration ||
        !Number.isSafeInteger(identity.nativeGeneration) || identity.nativeGeneration <= 0 ||
        identity.logicalWindowId !== callbackIdentity.logicalWindowId ||
        identity.launchGeneration !== callbackIdentity.launchGeneration ||
        identity.nativeGeneration !== callbackIdentity.nativeGeneration ||
        snapshot.callbackType !== "windowPlacementChanged" ||
        snapshot.sourceWindowMatches !== true || snapshot.callbackIdentityMatches !== true ||
        snapshot.currentNativeHandleMatches !== true || snapshot.currentWindowPointerMatches !== true ||
        !Number.isSafeInteger(snapshot.parentNativeHostId) || snapshot.parentNativeHostId <= 0 ||
        !/^(?:[a-f\d]{2})+$/i.test(snapshot.originalNativeHandle ?? "") ||
        journal.journalVersion !== 1 || journal.capacity !== 128 ||
        !natural(journal.sequence) || !natural(journal.dropped) || journal.records.length > 128) {
      throw new Error("The native resize carrier lost its exact attached owner");
    }
    let previous = 0;
    for (const record of journal.records) {
      if (!object(record) || !Number.isSafeInteger(record.sequence) ||
          record.sequence <= previous || record.sequence > journal.sequence ||
          record.windowID !== identity.logicalWindowId ||
          record.windowPointer !== snapshot.originalWindowPointer) {
        throw new Error("The native resize carrier mixed native record owners or sequences");
      }
      previous = record.sequence;
    }
    if (previous !== journal.sequence) throw new Error("The native resize carrier omitted its final sequence");
  }
  return { populatedOwners: populated.length,
    records: populated.reduce((total, snapshot) => total + snapshot.journal.records.length, 0),
    nativeDropped: populated.reduce((total, snapshot) => total + snapshot.journal.dropped, 0),
    droppedOwners: value.droppedOwners,
    methodWitnesses: populated.map(methodWitness) };
}

async function main() {
  const root = resolve(process.argv[2] ?? ".desktop-e2e-artifacts");
  const proofs = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filename = join(root, entry.name, "phases", "chromium-tabs-visible-seed",
      "electron-appkit-native-resize-observations.json");
    let raw;
    try { raw = await readFile(filename, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    proofs.push({ filename, ...verifyAppKitResizeDiagnosticCarrier(JSON.parse(raw)) });
  }
  if (!proofs.length) throw new Error("No terminal native resize carrier artifact was produced");
  const proof = { diagnosticChannelOnly: true, proofs };
  await writeFile(join(root, "native-resize-carrier-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

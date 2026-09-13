import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleTrustedInputExpectedEvent, ChromiumRoleTrustedInputDomReceipt } from "../ipc/chromiumRoleTrustedInputProtocol";
import { ChromiumPhysicalInputEvidenceLane, type ChromiumPhysicalInputEvidenceSnapshot } from "./chromiumPhysicalInputEvidence";

/** One evidence owner per live Role document, shared across arms and idle observations. */
export class ChromiumTrustedInputDocumentEvidence {
  readonly #roles = new Map<string, { frameToken: string; sequence: number | null;
    invalid: boolean; arms: Map<string, readonly ChromiumRoleTrustedInputExpectedEvent[]>;
    snapshot: ChromiumPhysicalInputEvidenceSnapshot; lane: ChromiumPhysicalInputEvidenceLane }>();
  begin(roleId: string, frameToken: string, snapshot: ChromiumPhysicalInputEvidenceSnapshot,
    fromObservation = false): ChromiumPhysicalInputEvidenceLane {
    let state = this.#roles.get(roleId);
    if (!state || state.frameToken !== frameToken) {
      const initial = fromObservation ? { ...snapshot, sequence: "0",
        ...(snapshot.keyDownSequence !== undefined ? { keyDownSequence: "0", keyUpSequence: "0" } : {}),
        ...(snapshot.keyboard ? { keyboard: { sequence: "0", events: [] } } : {}) } : snapshot;
      // Navigation replaces the document stream, not necessarily its native
      // responder journal. Preserve already-consumed native evidence across it.
      const retained = state && BigInt(snapshot.sequence) >= BigInt(state.snapshot.sequence) &&
        snapshot.keyboard && state.snapshot.keyboard &&
        BigInt(snapshot.keyboard.sequence) >= BigInt(state.snapshot.keyboard.sequence);
      state = { frameToken, sequence: null, invalid: false, arms: new Map(), snapshot,
        lane: retained ? state!.lane : new ChromiumPhysicalInputEvidenceLane(initial) };
      this.#roles.set(roleId, state);
    }
    state.snapshot = snapshot;
    if (state.invalid) throw new RionBridgeError({ code: "SYSTEM_TRUSTED_INPUT_OBSERVATION_STREAM_INDETERMINATE",
      message: "The document input observation stream has a gap or ambiguous late evidence." });
    return state.lane;
  }
  arm(roleId: string, inputSequence: string, expected: readonly ChromiumRoleTrustedInputExpectedEvent[]): void {
    const state = this.#roles.get(roleId);
    if (!state) return;
    state.arms.set(inputSequence, expected);
    if (state.arms.size > 32) state.arms.delete(state.arms.keys().next().value!);
  }
  late(roleId: string, receipt: ChromiumRoleTrustedInputDomReceipt,
    snapshot: ChromiumPhysicalInputEvidenceSnapshot): void {
    const state = this.#roles.get(roleId);
    if (!state || !receipt.isTrusted) return;
    const expected = state.arms.get(receipt.inputSequence);
    if (!expected) { state.invalid = true; return; }
    const couldBeAutomatic = expected.some(event => event.type === receipt.type &&
      event.code === receipt.code && event.button === receipt.button && event.repeat === receipt.repeat);
    if (couldBeAutomatic) {
      // A cancelled CDP edge and an equal physical edge remain ambiguous.
      if (state.lane.pendingPhysicalCount(snapshot, receipt) !== 0n) state.invalid = true;
      return;
    }
    // A different key/phase cannot be the old arm's automatic submission.
    if (state.lane.classify(snapshot, receipt) === "indeterminate") state.invalid = true;
  }
  observe(roleId: string, frameToken: string, sequence: number): boolean {
    const state = this.#roles.get(roleId);
    if (!state || state.frameToken !== frameToken) return false;
    if (!Number.isSafeInteger(sequence) || sequence < 1 ||
      (state.sequence !== null && sequence !== state.sequence + 1)) {
      state.invalid = true;
      return false;
    }
    state.sequence = sequence;
    return !state.invalid;
  }
  watermark(roleId: string, frameToken: string, sequence: number): boolean {
    const state = this.#roles.get(roleId);
    return Boolean(state && !state.invalid && state.frameToken === frameToken &&
      Number.isSafeInteger(sequence) && sequence === (state.sequence ?? 0));
  }
  retire(roleId: string, documentOnly = false): void {
    const state = this.#roles.get(roleId);
    if (documentOnly && state) {
      state.frameToken = "";
      state.arms.clear();
    } else this.#roles.delete(roleId);
  }
  clear(): void { this.#roles.clear(); }
}

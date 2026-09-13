const U64_MAX = 18_446_744_073_709_551_615n;

export interface ChromiumPhysicalInputEvidenceSnapshot {
  /** Projected DOM-event sequence from the exact native physical-input owner. */
  readonly sequence: string;
  /** Optional native key-phase cursors used by AppKit's physical Role owner. */
  readonly keyDownSequence?: string;
  readonly keyUpSequence?: string;
  /** False for hidden/background Roles and for a non-owning native surface. */
  readonly targetReceivesPhysicalInput: boolean;
}

export interface ChromiumPhysicalInputEvidenceObservation {
  readonly code?: string | null;
  readonly type: string;
}

export type ChromiumPhysicalInputEvidenceClassification =
  | "automatic"
  | "physical"
  | "indeterminate";

function parseSequence(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= U64_MAX ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One arm owns one native evidence cursor. A physical edge advances the exact
 * native sequence before its trusted DOM observation. CDP submissions never
 * enter this lane, so only observations without an unconsumed physical edge
 * may advance the automatic sequence.
 */
export class ChromiumPhysicalInputEvidenceLane {
  #accounted: bigint;
  #keyDownAccounted: bigint | null;
  #keyUpAccounted: bigint | null;
  #otherAccounted: bigint | null;

  constructor(snapshot: ChromiumPhysicalInputEvidenceSnapshot) {
    const sequence = parseSequence(snapshot.sequence);
    const keyDown = snapshot.keyDownSequence === undefined
      ? null : parseSequence(snapshot.keyDownSequence);
    const keyUp = snapshot.keyUpSequence === undefined
      ? null : parseSequence(snapshot.keyUpSequence);
    const phaseCursorsProvided = snapshot.keyDownSequence !== undefined ||
      snapshot.keyUpSequence !== undefined;
    if (sequence === null || typeof snapshot.targetReceivesPhysicalInput !== "boolean" ||
        (phaseCursorsProvided && (keyDown === null || keyUp === null)) ||
        (keyDown !== null && keyUp !== null && keyDown + keyUp > sequence)) {
      throw new Error("The native physical-input evidence snapshot is malformed.");
    }
    this.#accounted = sequence;
    this.#keyDownAccounted = keyDown;
    this.#keyUpAccounted = keyUp;
    this.#otherAccounted = keyDown === null || keyUp === null
      ? null : sequence - keyDown - keyUp;
  }

  classify(
    snapshot: ChromiumPhysicalInputEvidenceSnapshot,
    observation?: ChromiumPhysicalInputEvidenceObservation
  ): ChromiumPhysicalInputEvidenceClassification {
    const sequence = parseSequence(snapshot.sequence);
    const keyDown = snapshot.keyDownSequence === undefined
      ? null : parseSequence(snapshot.keyDownSequence);
    const keyUp = snapshot.keyUpSequence === undefined
      ? null : parseSequence(snapshot.keyUpSequence);
    const phaseCursorsValid = this.#keyDownAccounted !== null &&
      this.#keyUpAccounted !== null && this.#otherAccounted !== null &&
      keyDown !== null && keyUp !== null && keyDown + keyUp <= (sequence ?? -1n);
    if (sequence === null || typeof snapshot.targetReceivesPhysicalInput !== "boolean" ||
        sequence < this.#accounted ||
        ((snapshot.keyDownSequence !== undefined || snapshot.keyUpSequence !== undefined) &&
          !phaseCursorsValid)) {
      return "indeterminate";
    }
    if (!snapshot.targetReceivesPhysicalInput) {
      // A hidden/background Role cannot consume foreground-window evidence.
      this.#accounted = sequence;
      if (phaseCursorsValid) {
        this.#keyDownAccounted = keyDown;
        this.#keyUpAccounted = keyUp;
        this.#otherAccounted = sequence - keyDown - keyUp;
      }
      return "automatic";
    }
    if (phaseCursorsValid && observation) {
      const currentKeyDown = keyDown!;
      const currentKeyUp = keyUp!;
      const accountedKeyDown = this.#keyDownAccounted!;
      const accountedKeyUp = this.#keyUpAccounted!;
      const accountedOther = this.#otherAccounted!;
      const modifier = observation.code?.startsWith("Control") ||
        observation.code?.startsWith("Alt") ||
        observation.code?.startsWith("Shift") ||
        observation.code?.startsWith("Meta");
      const currentOther = sequence - currentKeyDown - currentKeyUp;
      if (currentKeyDown < accountedKeyDown || currentKeyUp < accountedKeyUp ||
          currentOther < accountedOther) return "indeterminate";
      const observesKeyDown = observation.type === "keydown" && !modifier;
      const observesKeyUp = observation.type === "keyup" && !modifier;
      if (observesKeyDown && currentKeyDown > accountedKeyDown) {
        this.#keyDownAccounted = accountedKeyDown + 1n;
      } else if (observesKeyUp && currentKeyUp > accountedKeyUp) {
        this.#keyUpAccounted = accountedKeyUp + 1n;
      } else if ((observesKeyDown && currentKeyUp > accountedKeyUp) ||
                 (observesKeyUp && currentKeyDown > accountedKeyDown)) {
        // The opposite physical phase may race a managed receipt. Preserve it
        // for its own observation; it cannot identify this automatic phase.
        return "automatic";
      } else if (currentOther > accountedOther) {
        // Modifier and pointer projections retain the total cursor semantics.
        // They may arrive while a non-modifier receipt is queued, so consume
        // one only after both exact key-phase cursors rule themselves out.
        this.#otherAccounted = accountedOther + 1n;
      } else {
        return "automatic";
      }
      this.#accounted += 1n;
      return "physical";
    }
    if (sequence === this.#accounted) return "automatic";
    this.#accounted += 1n;
    return "physical";
  }
}

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

type ChromiumPhysicalInputEvidenceCategory =
  | "keyDown"
  | "keyUp"
  | "other"
  | "total";

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

  sharesCategory(
    snapshot: ChromiumPhysicalInputEvidenceSnapshot,
    left: ChromiumPhysicalInputEvidenceObservation,
    right: ChromiumPhysicalInputEvidenceObservation
  ): boolean {
    const parsed = this.#parseSnapshot(snapshot);
    if (!parsed) return false;
    return this.#pendingCategory(parsed, left) ===
      this.#pendingCategory(parsed, right);
  }

  pendingPhysicalCount(
    snapshot: ChromiumPhysicalInputEvidenceSnapshot,
    observation: ChromiumPhysicalInputEvidenceObservation
  ): bigint | null {
    const parsed = this.#parseSnapshot(snapshot);
    if (!parsed || !snapshot.targetReceivesPhysicalInput) return parsed ? 0n : null;
    switch (this.#pendingCategory(parsed, observation)) {
      case "keyDown": return parsed.keyDown! - this.#keyDownAccounted!;
      case "keyUp": return parsed.keyUp! - this.#keyUpAccounted!;
      case "other": return parsed.other! - this.#otherAccounted!;
      case "total": return parsed.sequence - this.#accounted;
      case null: return 0n;
    }
  }

  classify(
    snapshot: ChromiumPhysicalInputEvidenceSnapshot,
    observation?: ChromiumPhysicalInputEvidenceObservation
  ): ChromiumPhysicalInputEvidenceClassification {
    const parsed = this.#parseSnapshot(snapshot);
    if (!parsed) return "indeterminate";
    if (!snapshot.targetReceivesPhysicalInput) {
      // A hidden/background Role cannot consume foreground-window evidence.
      this.#accounted = parsed.sequence;
      if (parsed.keyDown !== null && parsed.keyUp !== null && parsed.other !== null) {
        this.#keyDownAccounted = parsed.keyDown;
        this.#keyUpAccounted = parsed.keyUp;
        this.#otherAccounted = parsed.other;
      }
      return "automatic";
    }
    const pending = observation
      ? this.pendingPhysicalCount(snapshot, observation)
      : parsed.sequence - this.#accounted;
    if (pending === null) return "indeterminate";
    if (pending === 0n) return "automatic";
    if (observation && parsed.keyDown !== null) {
      switch (this.#pendingCategory(parsed, observation)) {
        case "keyDown": this.#keyDownAccounted! += 1n; break;
        case "keyUp": this.#keyUpAccounted! += 1n; break;
        case "other": this.#otherAccounted! += 1n; break;
        case "total": case null: return "indeterminate";
      }
      this.#accounted += 1n;
      return "physical";
    }
    this.#accounted += 1n;
    return "physical";
  }

  #category(
    observation: ChromiumPhysicalInputEvidenceObservation
  ): ChromiumPhysicalInputEvidenceCategory {
    if (this.#keyDownAccounted === null) return "total";
    const modifier = observation.code?.startsWith("Control") ||
      observation.code?.startsWith("Alt") ||
      observation.code?.startsWith("Shift") ||
      observation.code?.startsWith("Meta");
    if (observation.type === "keydown" && !modifier) return "keyDown";
    if (observation.type === "keyup" && !modifier) return "keyUp";
    return "other";
  }

  #pendingCategory(
    snapshot: {
      readonly sequence: bigint;
      readonly keyDown: bigint | null;
      readonly keyUp: bigint | null;
      readonly other: bigint | null;
    },
    observation: ChromiumPhysicalInputEvidenceObservation
  ): ChromiumPhysicalInputEvidenceCategory | null {
    if (snapshot.keyDown === null || snapshot.keyUp === null ||
        snapshot.other === null) return "total";
    const category = this.#category(observation);
    if (category === "total") return category;
    const keyDownPending = snapshot.keyDown! - this.#keyDownAccounted!;
    const keyUpPending = snapshot.keyUp! - this.#keyUpAccounted!;
    const otherPending = snapshot.other! - this.#otherAccounted!;
    if (category === "keyDown") {
      if (keyDownPending > 0n) return category;
      if (keyUpPending > 0n) return null;
      return otherPending > 0n ? "other" : null;
    }
    if (category === "keyUp") {
      if (keyUpPending > 0n) return category;
      if (keyDownPending > 0n) return null;
      return otherPending > 0n ? "other" : null;
    }
    return otherPending > 0n ? "other" : null;
  }

  #parseSnapshot(snapshot: ChromiumPhysicalInputEvidenceSnapshot): {
    readonly sequence: bigint;
    readonly keyDown: bigint | null;
    readonly keyUp: bigint | null;
    readonly other: bigint | null;
  } | null {
    const sequence = parseSequence(snapshot.sequence);
    const keyDown = snapshot.keyDownSequence === undefined
      ? null : parseSequence(snapshot.keyDownSequence);
    const keyUp = snapshot.keyUpSequence === undefined
      ? null : parseSequence(snapshot.keyUpSequence);
    const phaseProvided = snapshot.keyDownSequence !== undefined ||
      snapshot.keyUpSequence !== undefined;
    const phaseValid = this.#keyDownAccounted !== null &&
      this.#keyUpAccounted !== null && this.#otherAccounted !== null &&
      keyDown !== null && keyUp !== null && sequence !== null &&
      keyDown + keyUp <= sequence && keyDown >= this.#keyDownAccounted &&
      keyUp >= this.#keyUpAccounted &&
      sequence - keyDown - keyUp >= this.#otherAccounted;
    if (sequence === null || typeof snapshot.targetReceivesPhysicalInput !== "boolean" ||
        sequence < this.#accounted || (phaseProvided && !phaseValid)) return null;
    return {
      sequence,
      keyDown,
      keyUp,
      other: keyDown === null || keyUp === null ? null : sequence - keyDown - keyUp
    };
  }
}

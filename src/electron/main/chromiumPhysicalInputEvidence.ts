const U64_MAX = 18_446_744_073_709_551_615n;

export interface ChromiumPhysicalInputEvidenceSnapshot {
  /** Projected DOM-event sequence from the exact native physical-input owner. */
  readonly sequence: string;
  /** False for hidden/background Roles and for a non-owning native surface. */
  readonly targetReceivesPhysicalInput: boolean;
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

  constructor(snapshot: ChromiumPhysicalInputEvidenceSnapshot) {
    const sequence = parseSequence(snapshot.sequence);
    if (sequence === null || typeof snapshot.targetReceivesPhysicalInput !== "boolean") {
      throw new Error("The native physical-input evidence snapshot is malformed.");
    }
    this.#accounted = sequence;
  }

  classify(
    snapshot: ChromiumPhysicalInputEvidenceSnapshot
  ): ChromiumPhysicalInputEvidenceClassification {
    const sequence = parseSequence(snapshot.sequence);
    if (sequence === null || typeof snapshot.targetReceivesPhysicalInput !== "boolean" ||
        sequence < this.#accounted) {
      return "indeterminate";
    }
    if (!snapshot.targetReceivesPhysicalInput) {
      // A hidden/background Role cannot consume foreground-window evidence.
      this.#accounted = sequence;
      return "automatic";
    }
    if (sequence === this.#accounted) return "automatic";
    this.#accounted += 1n;
    return "physical";
  }
}

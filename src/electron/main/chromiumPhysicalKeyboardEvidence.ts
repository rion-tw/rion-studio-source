export interface ChromiumPhysicalKeyEvidence {
  readonly sequence: string;
  readonly code: string;
  readonly eventType: "keydown" | "keyup";
  readonly repeat: boolean;
  readonly consumed: boolean;
}
export interface ChromiumPhysicalKeyboardEvidence {
  readonly sequence: string;
  readonly events: readonly ChromiumPhysicalKeyEvidence[];
}
const sequence = (value: unknown): value is string => typeof value === "string" &&
  /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;

/** A bounded native journal, never a count of hypothetical future DOM events. */
export class ChromiumPhysicalKeyboardEvidenceLane {
  #watermark: bigint;
  #consumed = new Set<string>();
  constructor(evidence: ChromiumPhysicalKeyboardEvidence) {
    if (!sequence(evidence.sequence)) throw new Error("Malformed keyboard evidence sequence.");
    this.#watermark = BigInt(evidence.sequence);
  }
  pending(evidence: ChromiumPhysicalKeyboardEvidence, code: string, type: string,
    repeat?: boolean): readonly ChromiumPhysicalKeyEvidence[] | null {
    if (!sequence(evidence.sequence) || !Array.isArray(evidence.events) || evidence.events.length > 128 ||
      BigInt(evidence.sequence) < this.#watermark) return null;
    let previous = evidence.events.length ? BigInt(evidence.sequence) - BigInt(evidence.events.length) : BigInt(evidence.sequence);
    if (previous > this.#watermark) return null; // Truncation crossed an unconsumed boundary.
    for (const event of evidence.events) {
      if (!sequence(event.sequence) || BigInt(event.sequence) !== ++previous ||
        typeof event.code !== "string" || !event.code || event.code.length > 32 ||
        !["keydown", "keyup"].includes(event.eventType) || typeof event.repeat !== "boolean" ||
        typeof event.consumed !== "boolean") return null;
    }
    const fresh = evidence.events.filter(event => BigInt(event.sequence) > this.#watermark &&
      !this.#consumed.has(event.sequence) && !event.consumed);
    if (fresh.some(event => event.code === "Unidentified")) return null;
    return fresh.filter(event => event.code === code && event.eventType === type &&
      (repeat === undefined || event.repeat === repeat));
  }
  consume(event: ChromiumPhysicalKeyEvidence): void { this.#consumed.add(event.sequence); }
  advance(evidence: ChromiumPhysicalKeyboardEvidence): void {
    // Advance only over native-consumed or DOM-proven edges, preserving gaps.
    for (const event of evidence.events) {
      const next = BigInt(event.sequence);
      if (next <= this.#watermark) continue;
      if (next !== this.#watermark + 1n || (!event.consumed && !this.#consumed.has(event.sequence))) break;
      this.#watermark = next;
      this.#consumed.delete(event.sequence);
    }
  }
}

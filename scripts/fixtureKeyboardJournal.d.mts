export interface FixtureKeyboardEvent {
  kind: string;
  sequence: number;
  code: string;
  isTrusted: boolean;
  modifiers: { alt: boolean; control: boolean; meta: boolean; shift: boolean };
  consumerPressedCodes?: string[];
}
export interface FixtureKeyboardSnapshot {
  events: FixtureKeyboardEvent[];
  dropped: number;
}
export function createFixtureKeyboardJournal(): {
  record(kind: string, details: Omit<FixtureKeyboardEvent, "kind" | "sequence">): void;
  snapshot(): FixtureKeyboardSnapshot;
};

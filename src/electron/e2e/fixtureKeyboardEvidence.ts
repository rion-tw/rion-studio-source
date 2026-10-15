import type { FixtureKeyboardSnapshot } from "../../../scripts/fixtureKeyboardJournal.mjs";

export interface FixtureKeyboardEvidence {
  roleId: string;
  generation: number;
  tabId: string;
  fixtureRoleId: string;
  status: "captured" | "failed";
  documentInstanceId?: string;
  frameToken?: string;
  snapshot?: FixtureKeyboardSnapshot & { fixtureRoleId: string; documentToken: string };
  error?: string;
}

export interface FixtureKeyboardReleaseContext {
  kind: "native-quit";
  platform: "macos" | "windows";
}

type ModifierFlags = Readonly<Record<"alt" | "control" | "meta" | "shift", boolean>>;
const noModifiers: ModifierFlags = { alt: false, control: false, meta: false, shift: false };
function exactModifiers(actual: unknown, expected: ModifierFlags): boolean {
  if (typeof actual !== "object" || actual === null || Object.keys(actual).length !== 4) return false;
  return (Object.keys(noModifiers) as Array<keyof ModifierFlags>).every(
    key => (actual as ModifierFlags)[key] === expected[key]
  );
}

/** Receiver evidence is required independently of the compatible input receipt. */
export function assertFixtureKeyboardReleased(
  evidence: FixtureKeyboardEvidence, code: string, context?: FixtureKeyboardReleaseContext
): void {
  const snapshot = evidence.snapshot;
  if (evidence.status !== "captured" || !evidence.documentInstanceId || !evidence.frameToken ||
      !snapshot?.documentToken || snapshot.fixtureRoleId !== evidence.fixtureRoleId ||
      snapshot.dropped !== 0 || !Array.isArray(snapshot.events) || snapshot.events.length > 256) {
    throw new Error(`Missing exact terminal consumer evidence for ${evidence.roleId}: ${evidence.error ?? "invalid snapshot"}`);
  }
  const events = snapshot.events;
  if (events.some((event, index) => event.sequence !== index + 1)) {
    throw new Error("Terminal keyboard evidence has an unordered or incomplete sequence");
  }
  const phases = events.filter(event => event.code === code);
  const legacyCode = /^(?:Key[A-Z]|Digit[0-9])$/.test(code) ? code.at(-1)!.charCodeAt(0) : undefined;
  const quitModifiers = context?.kind === "native-quit"
    ? context.platform === "windows" ? { ...noModifiers, control: true }
      : context.platform === "macos" ? { ...noModifiers, meta: true } : undefined
    : undefined;
  const releasedModifiers = phases[2]?.modifiers;
  // The physical quit accelerator can release before or after Core's cleanup.
  // Only its exact platform modifier may accompany the two matching keyup events.
  const releaseModifiersAccepted = exactModifiers(releasedModifiers, noModifiers) ||
    (quitModifiers !== undefined && exactModifiers(releasedModifiers, quitModifiers));
  if (phases.map(event => event.kind).join(",") !== "keydown,consumer-keydown,keyup,consumer-keyup" ||
      legacyCode === undefined || phases.some(event => event.keyCode !== legacyCode || event.which !== legacyCode ||
        event.isTrusted !== false) ||
      !exactModifiers(phases[0]?.modifiers, noModifiers) || !exactModifiers(phases[1]?.modifiers, noModifiers) ||
      !releaseModifiersAccepted || !releasedModifiers || !exactModifiers(phases[3]?.modifiers, releasedModifiers) ||
      !phases[1]?.consumerPressedCodes?.includes(code) ||
      phases[3]?.consumerPressedCodes?.length !== 0 ||
      events.filter(event => event.kind.startsWith("consumer-")).at(-1)?.consumerPressedCodes?.length !== 0) {
    throw new Error(`The original document did not consume exactly one complete ${code} lifecycle`);
  }
}

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

/** Receiver evidence is required independently of the compatible input receipt. */
export function assertFixtureKeyboardReleased(evidence: FixtureKeyboardEvidence, code: string): void {
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
  if (phases.map(event => event.kind).join(",") !== "keydown,consumer-keydown,keyup,consumer-keyup" ||
      phases.some(event => event.isTrusted !== false || Object.values(event.modifiers).some(Boolean)) ||
      !phases[1]?.consumerPressedCodes?.includes(code) ||
      phases[3]?.consumerPressedCodes?.length !== 0 ||
      events.filter(event => event.kind.startsWith("consumer-")).at(-1)?.consumerPressedCodes?.length !== 0) {
    throw new Error(`The original document did not consume exactly one complete ${code} lifecycle`);
  }
}

import { requireEnvironment } from "./control";

export interface FixtureEvent {
  code?: string;
  coordinates?: { x: number; y: number };
  hidden?: boolean;
  key?: string;
  kind: string;
  modifiers?: { alt: boolean; control: boolean; meta: boolean; shift: boolean };
  roleId: string;
  sequence: number;
  session?: {
    after: { cookie: string | null; localStorage: string | null };
    before: { cookie: string | null; localStorage: string | null };
    marker: string;
    mode: "observe" | "seed";
  };
  targetId?: string;
  timestamp: string;
}

export interface FixtureRoleState {
  blur: number;
  click: number;
  focus: number;
  hidden: number;
  keydown: number;
  keyup: number;
  lastEvent: string;
  lastEventSequence: number;
  visible: number;
}

function fixtureUrl(path: string): string {
  return `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`;
}

export async function fixtureRequest(path: string, body: unknown): Promise<void> {
  const response = await fetch(fixtureUrl(path), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error(`Fixture ${path} failed with ${response.status}`);
}

export async function fixtureState(): Promise<Record<string, FixtureRoleState>> {
  const response = await fetch(fixtureUrl("/api/state"));
  if (!response.ok) throw new Error(`Fixture state failed with ${response.status}`);
  return response.json() as Promise<Record<string, FixtureRoleState>>;
}

export async function waitFixtureEvent(input: {
  afterSequence: number;
  kind?: string;
  roleId?: string;
  timeoutMs?: number;
}): Promise<FixtureEvent> {
  const query = new URLSearchParams({ afterSequence: String(input.afterSequence) });
  if (input.kind) query.set("kind", input.kind);
  if (input.roleId) query.set("roleId", input.roleId);
  const response = await fetch(fixtureUrl(`/api/events?${query}`), {
    signal: AbortSignal.timeout(input.timeoutMs ?? 45_000)
  });
  if (!response.ok) throw new Error(`Fixture event wait failed with ${response.status}`);
  return ((await response.json()) as { event: FixtureEvent }).event;
}

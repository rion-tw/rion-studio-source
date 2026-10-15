import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../e2e/desktop/support/control", () => ({
  requireEnvironment: () => "http://fixture.test"
}));

type Wait = (input: { afterSequence: number; kind?: string; roleId?: string;
  timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;
let waitFixtureEvent: Wait;
const fetchMock = vi.fn<typeof fetch>();
const event = { sequence: 84, kind: "keyup", roleId: "beta", code: "KeyY" };
const response = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" }
});

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  ({ waitFixtureEvent } = await vi.importActual<{ waitFixtureEvent: Wait }>("../e2e/desktop/support/fixture"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("rejects a pre-aborted receiver with its original reason before any fetch", async () => {
  const controller = new AbortController();
  const original = new Error("native sender already retired");
  controller.abort(original);
  fetchMock.mockResolvedValue(response({ event }));
  await expect(waitFixtureEvent({ afterSequence: 83, signal: controller.signal })).rejects.toBe(original);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("cancels the active event fetch with the original receiver reason and no diagnostic requests", async () => {
  const controller = new AbortController();
  const original = new Error("native sender cancelled");
  let activeSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementation((_url, options) => {
    activeSignal = options?.signal;
    return new Promise((_resolve, reject) => {
      activeSignal!.addEventListener("abort", () => reject(new DOMException("fetch aborted", "AbortError")), { once: true });
      controller.abort(original);
    });
  });
  await expect(waitFixtureEvent({ afterSequence: 83, kind: "keyup", roleId: "beta",
    signal: controller.signal })).rejects.toBe(original);
  expect(activeSignal?.aborted).toBe(true);
  expect(activeSignal?.reason).toBe(original);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("keeps the original timeout active alongside a caller signal", async () => {
  const caller = new AbortController(), timeout = new AbortController();
  const original = new DOMException("event deadline", "TimeoutError");
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  fetchMock.mockImplementation(async (url, options) => {
    if (String(url).includes("/api/events?")) return new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      timeout.abort(original);
    });
    return String(url).includes("snapshot") ? response({ events: [] }) : response({ beta: { pressedCodes: [] } });
  });
  await expect(waitFixtureEvent({ afterSequence: 83, roleId: "beta", timeoutMs: 9_000,
    signal: caller.signal })).rejects.toMatchObject({ cause: original });
  expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(9_000);
  expect(caller.signal.aborted).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("does not serialize receiver cancellation metadata into the fixture query", async () => {
  const controller = new AbortController();
  fetchMock.mockResolvedValue(response({ event }));
  await expect(waitFixtureEvent({ afterSequence: 83, roleId: "beta", kind: "keyup",
    timeoutMs: 12_000, signal: controller.signal })).resolves.toEqual(event);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe("http://fixture.test/api/events?afterSequence=83&kind=keyup&roleId=beta");
  expect(options?.body).toBeUndefined();
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});

it("preserves the original 45-second default and no-caller success behavior", async () => {
  const timeout = new AbortController();
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  fetchMock.mockResolvedValue(response({ event }));
  await expect(waitFixtureEvent({ afterSequence: 83 })).resolves.toEqual(event);
  expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(45_000);
  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeout.signal);
});

it("preserves no-caller fetch-failure diagnostics and the original cause", async () => {
  const original = new Error("fixture connection failed");
  fetchMock.mockRejectedValueOnce(original)
    .mockResolvedValueOnce(response({ events: [event] }))
    .mockResolvedValueOnce(response({ beta: { pressedCodes: [] } }));
  const failure = await waitFixtureEvent({ afterSequence: 83, roleId: "beta" }).catch(error => error);
  expect(failure).toMatchObject({ cause: original });
  expect(failure).toHaveProperty("message", expect.stringContaining('"events":[{"sequence":84'));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.slice(1).map(args => args.length)).toEqual([1, 1]);
});

it("cancels both pending fallback diagnostic fetches and preserves the receiver reason", async () => {
  const controller = new AbortController(), original = new Error("sender cancelled during diagnostics");
  const active: (AbortSignal | null | undefined)[] = [], aborted: string[] = [];
  let diagnosticsStarted!: () => void;
  const ready = new Promise<void>(resolve => { diagnosticsStarted = resolve; });
  fetchMock.mockImplementation((url, options) => {
    if (String(url).includes("/api/events?")) return Promise.reject(new Error("initial network failure"));
    active.push(options?.signal);
    const pending = new Promise<Response>((_resolve, reject) => {
      if (!options?.signal) { reject(new Error("diagnostic request is not cancellable")); return; }
      options.signal.addEventListener("abort", () => {
        aborted.push(String(url));
        reject(new DOMException("diagnostic aborted", "AbortError"));
      }, { once: true });
    });
    if (active.length === 2) diagnosticsStarted();
    return pending;
  });
  const outcome = waitFixtureEvent({ afterSequence: 83, roleId: "beta", signal: controller.signal })
    .catch(error => error);
  await ready;
  controller.abort(original);
  expect(await outcome).toBe(original);
  expect(active).toEqual([controller.signal, controller.signal]);
  expect(aborted).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.slice(1).map(([url]) => String(url))).toEqual([
    "http://fixture.test/api/events/snapshot?afterSequence=83&roleId=beta", "http://fixture.test/api/state"
  ]);
});

it("preserves the receiver cancellation reason while reading the event response body", async () => {
  const controller = new AbortController(), original = new Error("sender cancelled during body read");
  const body = response({ event });
  vi.spyOn(body, "json").mockImplementation(async () => {
    controller.abort(original);
    throw new DOMException("body aborted", "AbortError");
  });
  fetchMock.mockResolvedValue(body);
  await expect(waitFixtureEvent({ afterSequence: 83, signal: controller.signal })).rejects.toBe(original);
  expect(fetchMock).toHaveBeenCalledOnce();
});

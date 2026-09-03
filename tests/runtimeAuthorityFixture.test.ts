import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();

async function startFixture(): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(process.execPath, ["scripts/runtimeAuthorityFixtureServer.mjs", "--port=0"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  const origin = await new Promise<string>((resolve, reject) => {
    let output = "";
    const deadline = setTimeout(() => reject(new Error("Fixture startup timed out")), 10_000);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/runtime-authority-fixture (http:\/\/127\.0\.0\.1:\d+)/u);
      if (!match) return;
      clearTimeout(deadline);
      resolve(match[1]);
    });
    child.once("error", reject);
  });
  return { child, origin };
}

async function post(origin: string, path: string, value: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  children.clear();
});

describe("runtime authority fixture launch gates", () => {
  it("serves an executable role event and session script", async () => {
    const { origin } = await startFixture();
    const source = await (await fetch(`${origin}/role/test-role?mode=seed&marker=marker-a`)).text();
    const start = source.indexOf("<script>") + "<script>".length;
    const end = source.indexOf("</script>");
    expect(start).toBeGreaterThan("<script>".length - 1);
    expect(end).toBeGreaterThan(start);
    expect(() => new Function(source.slice(start, end))).not.toThrow();
    expect(source).toContain('const sessionMode = "seed"');
    expect(source).toContain('const sessionMarker = "marker-a"');
    expect(source).toContain('fetch("/api/session-cookie"');
    expect(source).toContain('addEventListener("load", () => void recordSession(), { once: true })');
    expect(source).toContain('<canvas id="game-input-canvas" tabindex="0"></canvas>');
    expect(source).toContain('<input id="text_input" type="text"');
    expect(source).toContain('qaTarget.addEventListener("mousedown", (event) => event.preventDefault())');
    expect(source).toContain('document.querySelector("#game-input-canvas").focus()');
    expect(source).toContain('recordCaret("flyff-caret-selection-before"');
    expect(source).toContain('recordCaret("flyff-caret-focus-after"');
    expect(source).toContain("isTrusted: event.isTrusted");
  });

  it("serves a visible late LocalStorage write without replaying it at load", async () => {
    const { origin } = await startFixture();
    const source = await (await fetch(
      `${origin}/role/test-role?mode=late-write&marker=marker-b`
    )).text();

    expect(source).toContain('const sessionMode = "late-write"');
    expect(source).toContain('qaTarget.textContent = "Save role LocalStorage marker"');
    expect(source).toContain('record("session-local-storage-updated"');
    expect(source.indexOf('if (sessionMode === "late-write") {'))
      .toBeLessThan(source.indexOf("localStorage.setItem(sessionKey, sessionMarker);"));
    expect(source).toContain('sessionMode === "seed" || sessionMode === "late-write"');
  });

  it("seeds and reads persistent session cookies through acknowledged HTTP responses", async () => {
    const { origin } = await startFixture();
    const response = await post(origin, "/api/session-cookie", { marker: "marker-a" });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBe(
      "rion-e2e-session=marker-a; Path=/; Max-Age=86400; SameSite=Strict"
    );
    const confirmation = await fetch(`${origin}/api/session-cookie`, {
      headers: { cookie: "rion-e2e-session=marker-a" }
    });
    expect(await confirmation.json()).toEqual({ cookie: "marker-a" });
  });

  it("assigns monotonic event sequences and resolves filtered event waits", async () => {
    const { origin } = await startFixture();
    const waiting = fetch(
      `${origin}/api/events?afterSequence=0&roleId=role-b&kind=keyup`
    );
    const first = await post(origin, "/api/event", {
      code: "KeyA",
      key: "a",
      kind: "keydown",
      modifiers: { alt: false, control: false, meta: false, shift: false },
      roleId: "role-a"
    });
    expect((await first.json()).event.sequence).toBe(1);
    const second = await post(origin, "/api/event", {
      code: "KeyB",
      key: "b",
      kind: "keyup",
      modifiers: { alt: false, control: true, meta: false, shift: false },
      roleId: "role-b"
    });
    expect((await second.json()).event.sequence).toBe(2);
    const waited = await (await waiting).json();
    expect(waited).toMatchObject({
      event: {
        code: "KeyB",
        kind: "keyup",
        roleId: "role-b",
        sequence: 2
      },
      latestSequence: 2
    });
    expect(await (await fetch(`${origin}/api/state`)).json()).toMatchObject({
      "role-a": { keydown: 1, lastEventSequence: 1, pressedCodes: ["KeyA"] },
      "role-b": { keyup: 1, lastEventSequence: 2, pressedCodes: [] }
    });
    expect(await (await fetch(
      `${origin}/api/events/snapshot?afterSequence=0&roleId=role-b`
    )).json()).toMatchObject({
      events: [{ code: "KeyB", kind: "keyup", sequence: 2 }],
      latestSequence: 2
    });
  });

  it("records bounded Flyff caret diagnostics without chat text", async () => {
    const { origin } = await startFixture();
    const response = await post(origin, "/api/event", {
      caret: {
        activeElementId: "text_input",
        requestedEnd: 4,
        requestedStart: 4,
        selectionEnd: 4,
        selectionStart: 4,
        textEditInvocation: 1,
        valueLength: 4
      },
      chatText: "must-not-be-recorded",
      defaultPrevented: false,
      isTrusted: true,
      kind: "flyff-caret-focus-after",
      roleId: "macro-keyboard-a"
    });
    const { event } = await response.json();

    expect(event).toMatchObject({
      caret: {
        activeElementId: "text_input",
        requestedEnd: 4,
        requestedStart: 4,
        selectionEnd: 4,
        selectionStart: 4,
        textEditInvocation: 1,
        valueLength: 4
      },
      defaultPrevented: false,
      isTrusted: true,
      kind: "flyff-caret-focus-after"
    });
    expect(event).not.toHaveProperty("chatText");
  });

  it("tracks pressed codes without duplicate repeat ownership and clears exact keyup", async () => {
    const { origin } = await startFixture();
    for (const kind of ["keydown", "keydown"]) {
      await post(origin, "/api/event", {
        code: "Digit1",
        isTrusted: true,
        kind,
        roleId: "role-a"
      });
    }
    expect(await (await fetch(`${origin}/api/state`)).json()).toMatchObject({
      "role-a": { pressedCodes: ["Digit1"], trustedPressedCodes: ["Digit1"] }
    });
    await post(origin, "/api/event", {
      code: "Digit1",
      isTrusted: false,
      kind: "keyup",
      roleId: "role-a"
    });
    expect(await (await fetch(`${origin}/api/state`)).json()).toMatchObject({
      "role-a": { pressedCodes: [], trustedPressedCodes: ["Digit1"] }
    });
    await post(origin, "/api/event", {
      code: "Digit1",
      isTrusted: true,
      kind: "keyup",
      roleId: "role-a"
    });
    expect(await (await fetch(`${origin}/api/state`)).json()).toMatchObject({
      "role-a": { pressedCodes: [], trustedPressedCodes: [] }
    });
  });

  it("models a trusted game consumer that re-evaluates held digits when Shift is pressed", async () => {
    const { origin } = await startFixture();
    await post(origin, "/api/event", {
      code: "Digit2",
      consumerChordActivations: [],
      consumerPressedCodes: ["Digit2"],
      consumerRevision: 1,
      isTrusted: true,
      kind: "consumer-keydown",
      roleId: "role-a"
    });
    await post(origin, "/api/event", {
      code: "ShiftLeft",
      consumerChordActivations: ["Shift+Digit2"],
      consumerPressedCodes: ["Digit2", "ShiftLeft"],
      consumerRevision: 2,
      isTrusted: true,
      kind: "consumer-keydown",
      roleId: "role-a"
    });
    expect(await (await fetch(`${origin}/api/state`)).json()).toMatchObject({
      "role-a": {
        consumerChordActivations: ["Shift+Digit2"],
        consumerPressedCodes: ["Digit2", "ShiftLeft"]
      }
    });
    await post(origin, "/api/event", {
      code: "ShiftLeft",
      consumerChordActivations: ["stale"],
      consumerPressedCodes: ["Digit2"],
      consumerRevision: 1,
      isTrusted: true,
      kind: "consumer-keyup",
      roleId: "role-a"
    });
    await post(origin, "/api/event", {
      code: "ShiftLeft",
      consumerChordActivations: ["Shift+Digit2"],
      consumerPressedCodes: ["ShiftLeft"],
      consumerRevision: 3,
      isTrusted: true,
      kind: "consumer-keydown",
      roleId: "role-a"
    });
    expect(await (await fetch(`${origin}/api/state`)).json()).toMatchObject({
      "role-a": {
        consumerChordActivations: ["Shift+Digit2"],
        consumerPressedCodes: ["ShiftLeft"]
      }
    });
  });

  it("keeps event sequence monotonic when fixture state is reset", async () => {
    const { origin } = await startFixture();
    await post(origin, "/api/event", { kind: "focus", roleId: "role-a" });
    await post(origin, "/api/reset", {});
    const recorded = await post(origin, "/api/event", { kind: "blur", roleId: "role-a" });
    expect((await recorded.json()).event.sequence).toBe(2);
  });

  it("holds navigation until an explicit release event", async () => {
    const { origin } = await startFixture();
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({
      ok: true,
      port: Number(new URL(origin).port)
    });
    expect((await post(origin, "/api/gate", { roleId: "test-role" })).ok).toBe(true);
    let roleResolved = false;
    const role = fetch(`${origin}/role/test-role?mode=seed&marker=gated-marker`).then((response) => {
      roleResolved = true;
      return response;
    });
    const waiting = await fetch(`${origin}/api/gates/test-role/waiting`);
    expect(await waiting.json()).toEqual({ roleId: "test-role", waiterCount: 1 });
    expect(roleResolved).toBe(false);
    expect((await post(origin, "/api/release", { roleId: "test-role" })).ok).toBe(true);
    const released = await role;
    expect(released.status).toBe(200);
    const source = await released.text();
    expect(source).toContain('const sessionMode = "seed"');
    expect(source).toContain('const sessionMarker = "gated-marker"');
  });

  it("records an event-bound gated navigation transport cancellation", async () => {
    const { origin } = await startFixture();
    expect((await post(origin, "/api/gate", { roleId: "cancelled-role" })).ok)
      .toBe(true);
    const controller = new AbortController();
    const navigation = fetch(`${origin}/role/cancelled-role`, {
      signal: controller.signal
    }).then(() => false, () => true);
    const waiting = await fetch(`${origin}/api/gates/cancelled-role/waiting`);
    expect(await waiting.json()).toEqual({
      roleId: "cancelled-role",
      waiterCount: 1
    });
    const cancelled = fetch(
      `${origin}/api/events?afterSequence=0&` +
      "roleId=cancelled-role&kind=gated-navigation-transport-cancelled"
    );

    controller.abort();

    expect(await navigation).toBe(true);
    expect((await (await cancelled).json()).event).toMatchObject({
      kind: "gated-navigation-transport-cancelled",
      roleId: "cancelled-role"
    });
  });

  it("fails one navigation and holds recovery until failure injection is released", async () => {
    const { origin } = await startFixture();
    expect((await post(origin, "/api/navigation-failure", {
      enabled: true,
      roleId: "recovery-role"
    })).ok).toBe(true);

    const failedNavigation = fetch(`${origin}/role/recovery-role`)
      .then((response) => response.text())
      .then(() => false, () => true);
    const attempted = await fetch(
      `${origin}/api/navigation-failures/recovery-role/attempted`
    );
    expect(await attempted.json()).toEqual({ failedAttempts: 1, roleId: "recovery-role" });
    expect(await failedNavigation).toBe(true);

    let recoveryResolved = false;
    const recoveryNavigation = fetch(`${origin}/role/recovery-role`).then((response) => {
      recoveryResolved = true;
      return response;
    });
    const waiting = await fetch(
      `${origin}/api/navigation-failures/recovery-role/recovery-waiting`
    );
    expect(await waiting.json()).toEqual({ roleId: "recovery-role", waiterCount: 1 });
    expect(recoveryResolved).toBe(false);

    expect((await post(origin, "/api/navigation-failure", {
      enabled: false,
      roleId: "recovery-role"
    })).ok).toBe(true);
    expect((await recoveryNavigation).status).toBe(200);
  });

  it("exposes the active-navigation failure control only for the recovery Role", async () => {
    const { origin } = await startFixture();
    const recovery = await (await fetch(
      `${origin}/role/chromium-workspaces-recovery-failing`
    )).text();
    const healthy = await (await fetch(
      `${origin}/role/chromium-workspaces-recovery-healthy`
    )).text();

    expect(recovery).toContain('id="active-navigation-failure"');
    expect(recovery).toContain(
      'roleId === "chromium-workspaces-recovery-failing"'
    );
    expect(recovery).toContain('record("navigation-requested"');
    expect(recovery).toContain("isTrusted: event.isTrusted");
    expect(recovery).toContain("window.location.assign(window.location.href)");
    expect(healthy).toContain("activeNavigationFailure.hidden = false");
    expect(healthy).toContain(
      'roleId === "chromium-workspaces-recovery-failing"'
    );
  });

  it("exposes visible permission and attachment controls only to the security fixture", async () => {
    const { origin } = await startFixture();
    const security = await (await fetch(
      `${origin}/role/chromium-workspace-web-fullscreen`
    )).text();
    const ordinary = await (await fetch(`${origin}/role/test-role`)).text();

    for (const marker of [
      'id="permission-geolocation"',
      'id="blocked-download"',
      'record("permission-requested"',
      'navigator.geolocation.getCurrentPosition(',
      'record("permission-denied"',
      'record("download-requested"'
    ]) {
      expect(security).toContain(marker);
    }
    expect(security).toContain('const securityPolicyEnabled = roleId ===');
    expect(ordinary).toContain("permissionButton.hidden = !securityPolicyEnabled");
    expect(ordinary).toContain("downloadLink.hidden = !securityPolicyEnabled");
  });

  it("holds attachment transport until the exact client cancellation event", async () => {
    const { origin } = await startFixture();
    const controller = new AbortController();
    const response = await fetch(
      `${origin}/download/chromium-workspace-web-fullscreen`,
      { signal: controller.signal }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="chromium-workspace-web-fullscreen.txt"'
    );
    const started = await fetch(
      `${origin}/api/events?afterSequence=0&` +
      "roleId=chromium-workspace-web-fullscreen&kind=download-response-started"
    );
    expect((await started.json()).event).toMatchObject({
      kind: "download-response-started",
      roleId: "chromium-workspace-web-fullscreen"
    });

    const cancelled = fetch(
      `${origin}/api/events?afterSequence=0&` +
      "roleId=chromium-workspace-web-fullscreen&kind=download-transport-cancelled"
    );
    controller.abort();
    expect((await (await cancelled).json()).event).toMatchObject({
      kind: "download-transport-cancelled",
      roleId: "chromium-workspace-web-fullscreen"
    });
  });
});

import { createServer } from "node:http";

const DEFAULT_PORT = 41739;
const portArgument = process.argv.find((value) => value.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) ?? DEFAULT_PORT);
if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) {
  throw new Error("Fixture port must be zero or an integer between 1024 and 65535.");
}
let activePort = port;

const counters = new Map();
const gates = new Map();

function roleCounters(roleId) {
  const current = counters.get(roleId) ?? {
    blur: 0,
    click: 0,
    focus: 0,
    hidden: 0,
    keydown: 0,
    lastEvent: "boot",
    visible: 0
  };
  counters.set(roleId, current);
  return current;
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8"
  });
  response.end(body);
}

function localRequest(request) {
  const host = request.headers.host?.split(":")[0]?.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

async function requestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16_384) throw new Error("fixture request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function rolePage(roleId) {
  const safeRoleId = JSON.stringify(roleId).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>[Runtime QA] ${roleId}</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #10141d; color: #ecf2ff; }
    main { width: min(760px, calc(100vw - 40px)); padding: 28px; border: 2px solid #5eead4; border-radius: 18px; background: #182131; box-shadow: 0 24px 80px #0008; }
    h1 { margin: 0 0 8px; color: #5eead4; }
    p { color: #a9b7ce; }
    button { display: block; width: 240px; height: 72px; margin: 28px auto; border: 0; border-radius: 14px; background: #7c3aed; color: white; font: inherit; font-size: 18px; cursor: pointer; }
    dl { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    div { padding: 12px; border-radius: 10px; background: #0e1522; }
    dt { color: #8ea0bc; font-size: 12px; } dd { margin: 5px 0 0; font-size: 22px; }
    #last-event { color: #fbbf24; }
  </style>
</head>
<body>
  <main>
    <h1>[Runtime QA] <span id="role-id"></span></h1>
    <p>Local-only WKWebView/WebView2 lifecycle, focus, input, and macro fixture.</p>
    <button id="qa-target" type="button">Macro click target</button>
    <dl>
      <div><dt>click</dt><dd id="click">0</dd></div>
      <div><dt>keydown</dt><dd id="keydown">0</dd></div>
      <div><dt>focus</dt><dd id="focus">0</dd></div>
      <div><dt>visibility</dt><dd id="visibility">0</dd></div>
    </dl>
    <p>Last event: <strong id="last-event">boot</strong></p>
  </main>
  <script>
    const roleId = ${safeRoleId};
    const counts = { click: 0, keydown: 0, focus: 0, visibility: 0 };
    document.querySelector("#role-id").textContent = roleId;
    const render = (kind) => {
      for (const [key, value] of Object.entries(counts)) document.querySelector("#" + key).textContent = String(value);
      document.querySelector("#last-event").textContent = kind;
    };
    const record = (kind) => {
      if (kind in counts) counts[kind] += 1;
      render(kind);
      fetch("/api/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roleId, kind }),
        keepalive: true
      }).catch(() => {});
    };
    document.querySelector("#qa-target").addEventListener("click", () => record("click"));
    addEventListener("keydown", () => record("keydown"), true);
    addEventListener("focus", () => record("focus"));
    addEventListener("blur", () => record("blur"));
    document.addEventListener("visibilitychange", () => record(document.hidden ? "hidden" : "visibility"));
    record(document.hidden ? "hidden" : "visibility");
  </script>
</body>
</html>`;
}

function sendRolePage(response, roleId) {
  const body = rolePage(roleId);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function gateState(roleId) {
  const current = gates.get(roleId) ?? {
    blocked: false,
    observers: new Set(),
    waiters: new Set()
  };
  gates.set(roleId, current);
  return current;
}

function releaseGate(roleId) {
  const gate = gateState(roleId);
  gate.blocked = false;
  for (const response of gate.waiters) sendRolePage(response, roleId);
  gate.waiters.clear();
  for (const response of gate.observers) {
    json(response, 200, { released: true, roleId, waiterCount: 0 });
  }
  gate.observers.clear();
}

function notifyGateObservers(roleId, gate) {
  if (gate.waiters.size === 0) return;
  for (const response of gate.observers) {
    json(response, 200, { roleId, waiterCount: gate.waiters.size });
  }
  gate.observers.clear();
}

const server = createServer(async (request, response) => {
  if (!localRequest(request)) {
    json(response, 403, { error: "localhost-only fixture" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true, port: activePort });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      json(response, 200, Object.fromEntries([...counters.entries()].sort()));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/gates") {
      json(response, 200, Object.fromEntries(
        [...gates.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([roleId, gate]) => [roleId, {
            blocked: gate.blocked,
            waiterCount: gate.waiters.size
          }])
      ));
      return;
    }
    const waiterMatch = request.method === "GET"
      && url.pathname.match(/^\/api\/gates\/([a-z0-9-]+)\/waiting$/);
    if (waiterMatch) {
      const roleId = waiterMatch[1];
      const gate = gateState(roleId);
      if (gate.waiters.size > 0) {
        json(response, 200, { roleId, waiterCount: gate.waiters.size });
        return;
      }
      gate.observers.add(response);
      response.once("close", () => gate.observers.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/reset") {
      counters.clear();
      for (const roleId of gates.keys()) releaseGate(roleId);
      gates.clear();
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/gate") {
      const body = await requestBody(request);
      if (typeof body.roleId !== "string" || !/^[a-z0-9-]+$/.test(body.roleId)) {
        json(response, 400, { error: "invalid fixture gate" });
        return;
      }
      const gate = gateState(body.roleId);
      gate.blocked = true;
      json(response, 200, { blocked: true, roleId: body.roleId });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/release") {
      const body = await requestBody(request);
      if (typeof body.roleId !== "string" || !/^[a-z0-9-]+$/.test(body.roleId)) {
        json(response, 400, { error: "invalid fixture release" });
        return;
      }
      releaseGate(body.roleId);
      json(response, 200, { blocked: false, roleId: body.roleId });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/event") {
      const body = await requestBody(request);
      if (typeof body.roleId !== "string" || typeof body.kind !== "string") {
        json(response, 400, { error: "invalid fixture event" });
        return;
      }
      const state = roleCounters(body.roleId);
      if (Object.hasOwn(state, body.kind)) state[body.kind] += 1;
      state.lastEvent = body.kind;
      json(response, 200, state);
      return;
    }
    const roleMatch = request.method === "GET" && url.pathname.match(/^\/role\/([a-z0-9-]+)$/);
    if (roleMatch) {
      const roleId = roleMatch[1];
      const gate = gateState(roleId);
      if (!gate.blocked) {
        sendRolePage(response, roleId);
        return;
      }
      gate.waiters.add(response);
      notifyGateObservers(roleId, gate);
      response.once("close", () => gate.waiters.delete(response));
      return;
    }
    json(response, 404, { error: "fixture route not found" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  activePort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`runtime-authority-fixture http://127.0.0.1:${activePort}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

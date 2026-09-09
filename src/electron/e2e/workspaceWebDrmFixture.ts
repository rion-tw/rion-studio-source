import { net, type Session } from "electron";

const installed = new WeakSet<Session>();
const FIXTURE_HOST = "rion-drm.fixture.test";

/** E2E-only local HTTPS transport. No certificate override, remote-site rewrite,
 * permission override, or production registration is installed by this fixture.
 */
export function installWorkspaceWebDrmFixture(session: Session): void {
  if (installed.has(session)) return;
  const origin = new URL(process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN!);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" ||
      origin.pathname !== "/" || origin.username || origin.password ||
      !process.env.RION_STUDIO_E2E_SESSION_TOKEN) {
    throw new Error("DRM fixture requires the authenticated local E2E server.");
  }
  session.protocol.handle("https", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== FIXTURE_HOST || url.port || url.username || url.password) {
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    const local = new URL(url.pathname + url.search, origin);
    const headers = new Headers(request.headers);
    headers.set("host", local.host);
    // Protocol requests expose streamed bodies. Reconstructing a keepalive
    // Request with that stream throws before the fixture receives the event.
    return globalThis.fetch(local.href, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined : await request.arrayBuffer(),
      signal: request.signal,
      redirect: "manual"
    });
  });
  installed.add(session);
}

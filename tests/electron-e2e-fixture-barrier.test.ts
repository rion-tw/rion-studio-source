import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { waitForFixtureBarrier } from "../src/electron/e2e/fixtureBarrier";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function gate(status = 200) {
  let acknowledge!: (response: ServerResponse) => void;
  const received = new Promise<ServerResponse>(resolve => { acknowledge = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(status);
    response.flushHeaders();
    acknowledge(response);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
  return { url: `http://127.0.0.1:${address.port}/gate`, received };
}

it("waits for exact response completion after headers and partial content", async () => {
  const fixture = await gate();
  let completed = false;
  const waiting = waitForFixtureBarrier(fixture.url).then(() => { completed = true; });
  const response = await fixture.received;
  await new Promise<void>(resolve => response.write("held", () => resolve()));
  expect(completed).toBe(false);
  response.end("released");
  await waiting;
  expect(completed).toBe(true);
});

it("rejects a failed HTTP acknowledgement", async () => {
  const fixture = await gate(503);
  const waiting = waitForFixtureBarrier(fixture.url);
  (await fixture.received).end();
  await expect(waiting).rejects.toThrow("HTTP 503");
});

it("rejects cancellation before release", async () => {
  const fixture = await gate();
  const waiting = waitForFixtureBarrier(fixture.url);
  const rejected = expect(waiting).rejects.toThrow();
  (await fixture.received).destroy();
  await rejected;
});

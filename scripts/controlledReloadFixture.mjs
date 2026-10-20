/**
 * Non-committing controlled Reload precondition for the Role fixture. The
 * desktop E2E arms it before selecting the visible Reload; it performs nothing.
 */
export function createControlledReloadFixture({ json, recordFixtureEvent, requestBody }) {
  const noContentNavigations = new Set();
  return Object.freeze({
    reset() {
      noContentNavigations.clear();
    },
    /** Arms one 204 answer for the next request of a Role page. */
    async serveControl(request, response, url) {
      if (request.method !== "POST" || url.pathname !== "/api/no-content-navigation") {
        return false;
      }
      const body = await requestBody(request);
      if (typeof body.roleId !== "string" || !/^[a-z0-9-]+$/.test(body.roleId)) {
        json(response, 400, { error: "invalid fixture no-content navigation" });
        return true;
      }
      noContentNavigations.add(body.roleId);
      json(response, 200, { armed: true, roleId: body.roleId });
      return true;
    },
    /** A 204 never commits: Chromium keeps the running document and stops loading. */
    serveRolePage(response, roleId) {
      if (!noContentNavigations.delete(roleId)) return false;
      recordFixtureEvent({ kind: "role-no-content-served", roleId });
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return true;
    }
  });
}

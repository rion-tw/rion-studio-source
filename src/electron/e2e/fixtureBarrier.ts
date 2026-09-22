import { get } from "node:http";

/** E2E-only event-bound gate: release, stream failure, or connection cancellation. */
export function waitForFixtureBarrier(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Node fetch has an implicit body inactivity deadline. Native presentation
    // matrices intentionally hold this local fixture stream longer than that.
    // HTTP has no socket deadline here; only the exact response end is release.
    const request = get(url, response => {
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("Fixture barrier transport cancelled")));
      if (response.statusCode !== 200) {
        reject(new Error(`Fixture barrier failed with HTTP ${response.statusCode}`));
      } else {
        response.once("end", resolve);
      }
      response.resume();
    });
    request.once("error", reject);
  });
}

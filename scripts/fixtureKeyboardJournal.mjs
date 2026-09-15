/** Runs inside the fixture document; HTTP delivery is deliberately independent. */
export function createFixtureKeyboardJournal() {
  const events = [];
  let sequence = 0;
  let dropped = 0;
  return {
    record(kind, details) {
      if (!["keydown", "keyup", "consumer-keydown", "consumer-keyup"].includes(kind)) return;
      events.push({ ...details, kind, sequence: ++sequence });
      if (events.length > 256) { events.shift(); dropped += 1; }
    },
    snapshot() { return JSON.parse(JSON.stringify({ events, dropped })); }
  };
}

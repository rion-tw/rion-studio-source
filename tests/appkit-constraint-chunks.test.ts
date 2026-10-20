import { describe, expect, it } from "vitest";
import { appKitConstraintPrefixes, assembleAppKitConstraintFragments } from
  "../scripts/collectAppKitConstraintDiagnostics.mjs";

const id = "10000000-0000-4000-8000-000000000001";
const prefix = appKitConstraintPrefixes[0]!;
const snapshot = { windowPointer: "0x1234", contentViewClass: "BridgedContentView界",
  minSize: { width: 640, height: 512 }, contentMinSize: { width: 640, height: 480 },
  metadata: "x".repeat(1300) };
const chunks = (bytes = Buffer.from(JSON.stringify(snapshot)), processId = 731, messagePrefix = prefix) => {
  const data = bytes.toString("base64");
  const count = Math.ceil(data.length/320);
  return Array.from({ length: count }, (_, index) => ({ processId,
    timestamp: `2026-10-14 22:00:00.${index}00000+0000`,
    eventMessage: messagePrefix+JSON.stringify({ type: "chunk", id, index, count,
      data: data.slice(index*320, (index+1)*320) })
  }));
};
type Fragment = ReturnType<typeof chunks>[number];
const change = (fragment: Fragment, fields: Record<string, unknown>) => ({ ...fragment,
  eventMessage: prefix+JSON.stringify({ ...JSON.parse(fragment.eventMessage.slice(prefix.length)), ...fields })
});

describe("exact native AppKit fragment assembly", () => {
  it("reconstructs a snapshot larger than the observed 1018-character native log limit", () => {
    const fragments = chunks();
    for (const fragment of fragments) expect(Buffer.byteLength(fragment.eventMessage, "utf8")).toBeLessThan(700);
    const result = assembleAppKitConstraintFragments(fragments, [731]);
    expect(result.summary).toMatchObject({ fragmentCount: fragments.length, errorCount: 0,
      completedSnapshotCount: 1, failedSnapshotCount: 0 });
    expect(result.rows).toEqual([{ processId: 731, prefix: prefix.trimEnd(), id,
      timestamp: fragments[0]!.timestamp, data: snapshot }]);
  });

  it("admits reordered fragments only after all indices are complete", () => {
    expect(assembleAppKitConstraintFragments(chunks().reverse(), [731]).rows[0]?.data).toEqual(snapshot);
  });

  it("keeps matching UUIDs separated by exact PID and prefix", () => {
    const first = chunks();
    const second = chunks(Buffer.from(JSON.stringify({ phase: "mouseDragged-after" })), 732,
      appKitConstraintPrefixes[1]);
    const third = chunks(Buffer.from(JSON.stringify({ phase: "mouseDown" })), 731,
      appKitConstraintPrefixes[1]);
    const result = assembleAppKitConstraintFragments([...first, ...second, ...third], [731, 732]);
    expect(result.summary.errorCount).toBe(0);
    expect(result.rows).toHaveLength(3);
  });

  it("rejects a missing fragment without deriving partial native truth", () => {
    const result = assembleAppKitConstraintFragments(chunks().slice(1), [731]);
    expect(result.rows).toEqual([]);
    expect(result.summary.errors.join(" ")).toContain("missing chunks");
  });

  it.each([false, true])("rejects a duplicate index (conflicting data: %s)", conflict => {
    const fragments = chunks();
    const duplicate = conflict ? change(fragments[0]!, { data: "e30=" }) : fragments[0]!;
    const result = assembleAppKitConstraintFragments([...fragments, duplicate], [731]);
    expect(result.rows).toEqual([]);
    expect(result.summary.errors.join(" ")).toContain(conflict ? "conflicting chunk" : "duplicate chunk");
  });

  it("rejects inconsistent counts for one scoped snapshot", () => {
    const fragments = chunks();
    fragments[1] = change(fragments[1]!, { count: fragments.length+1 });
    const result = assembleAppKitConstraintFragments(fragments, [731]);
    expect(result.rows).toEqual([]);
    expect(result.summary.errors.join(" ")).toContain("conflicting chunk counts");
  });

  it("retains a complete snapshot while explicitly reporting another snapshot's missing fragment", () => {
    const result = assembleAppKitConstraintFragments([...chunks(), ...chunks(undefined, 732).slice(1)], [731, 732]);
    expect(result.rows).toHaveLength(1);
    expect(result.summary).toMatchObject({ completedSnapshotCount: 1, failedSnapshotCount: 1, errorCount: 1 });
  });

  it("rejects truncated chunk JSON rather than filling a missing suffix", () => {
    const fragment = chunks()[0]!;
    const result = assembleAppKitConstraintFragments([{ ...fragment, eventMessage: fragment.eventMessage.slice(0, -8)+"<…>" }], [731]);
    expect(result.rows).toEqual([]);
    expect(result.summary.errors.join(" ")).toContain("incomplete chunk JSON");
  });

  it.each([{ count: 129 }, { count: 0 }, { index: -1 }, { index: 1.5 }, { index: 128 },
    { data: "" }, { data: "x".repeat(321) }, { data: "not base64!" }, { id: "../another" },
    { type: "snapshot" }, { unknown: true }])("rejects malformed envelope %j", fields => {
    const result = assembleAppKitConstraintFragments([change(chunks()[0]!, fields)], [731]);
    expect(result.rows).toEqual([]);
    expect(result.summary.errorCount).toBe(1);
  });

  it("rejects noncanonical Base64 even if the decoder accepts its nonzero padding bits", () => {
    const fragment = change(chunks()[0]!, { count: 1, index: 0, data: "AB==" });
    const result = assembleAppKitConstraintFragments([fragment], [731]);
    expect(result.rows).toEqual([]);
    expect(result.summary.errorCount).toBe(1);
  });

  it.each([
    Buffer.from([0xff, 0xfe]), Buffer.from("{\"frame\":"),
    Buffer.from(JSON.stringify({ serializationError: true, reason: "payload-too-large" })),
    Buffer.from(JSON.stringify({ content: "x".repeat(16*1024) })),
    Buffer.from("[]")
  ])("rejects invalid UTF-8, incomplete JSON or oversized/failed native serialization", bytes => {
    const result = assembleAppKitConstraintFragments(chunks(bytes), [731]);
    expect(result.rows).toEqual([]);
    expect(result.summary.errorCount).toBe(1);
  });

  it("rejects a different process or prefix before any native snapshot admission", () => {
    const fragment = chunks()[0]!;
    const result = assembleAppKitConstraintFragments([
      { ...fragment, processId: 999 }, { ...fragment, eventMessage: "unrelated "+fragment.eventMessage }
    ], [731]);
    expect(result.rows).toEqual([]);
    expect(result.summary.errorCount).toBe(2);
  });
});

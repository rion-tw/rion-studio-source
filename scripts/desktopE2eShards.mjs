/**
 * Splits one desktop E2E profile across parallel runners without separating
 * phases that share state. Phases joined by a focused-run prerequisite or by a
 * user-data namespace always land in the same shard, keep their profile order,
 * and run on one fresh runner exactly as they do in an unsharded run.
 */

/** Relative CI cost in minutes; unlisted phases count as one minute. */
export const DESKTOP_E2E_PHASE_WEIGHTS = Object.freeze({
  "chromium-workspace-gap-dividers-seed": 7,
  "chromium-tabs-visible-seed": 5,
  "chromium-tab-tearout": 2,
  "chromium-extensions-seed": 2,
  "chromium-workspace-shared-role": 2,
  "chromium-macro-cutover-keyboard": 2
});

/** Parses `--shard=index/count` (1-based); returns undefined when absent. */
export function parseDesktopE2eShard(argument) {
  if (argument === undefined) return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(argument);
  if (!match) throw new Error(`Desktop E2E shard must be index/count, got ${argument}.`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count || count > 8) {
    throw new Error(`Desktop E2E shard ${argument} is outside 1..count (at most 8).`);
  }
  return Object.freeze({ count, index });
}

/**
 * @param {Readonly<{
 *   phases: readonly string[];
 *   dependencies: ReadonlyMap<string, readonly string[]>;
 *   namespaces: ReadonlyMap<string, string>;
 *   prerequisites?: (phase: string) => readonly string[];
 *   count: number;
 *   weights?: Readonly<Record<string, number>>;
 * }>} input
 * @returns {string[][]} one ordered phase list per shard
 */
export function partitionDesktopE2ePhases({
  phases, dependencies, namespaces, prerequisites = () => [], count,
  weights = DESKTOP_E2E_PHASE_WEIGHTS
}) {
  if (!Number.isInteger(count) || count < 1) throw new Error("Desktop E2E shard count must be positive.");
  if (new Set(phases).size !== phases.length) throw new Error("Desktop E2E profile repeats a phase.");
  const order = new Map(phases.map((phase, index) => [phase, index]));
  const parent = new Map(phases.map(phase => [phase, phase]));
  const find = (phase) => {
    let root = phase;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(phase, root);
    return root;
  };
  const join = (left, right) => {
    // A prerequisite outside the profile cannot run here; the unsharded runner
    // rejects it the same way when a focused phase needs it.
    if (!order.has(right)) {
      throw new Error(`Desktop E2E prerequisite ${right} of ${left} is not part of the profile.`);
    }
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(order.get(a) < order.get(b) ? b : a, order.get(a) < order.get(b) ? a : b);
  };
  const byNamespace = new Map();
  for (const phase of phases) {
    for (const dependency of dependencies.get(phase) ?? []) join(phase, dependency);
    for (const prerequisite of prerequisites(phase)) if (prerequisite !== phase) join(phase, prerequisite);
    const namespace = namespaces.get(phase);
    if (namespace === undefined) continue;
    if (byNamespace.has(namespace)) join(phase, byNamespace.get(namespace));
    else byNamespace.set(namespace, phase);
  }
  const groups = new Map();
  for (const phase of phases) {
    const root = find(phase);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(phase);
  }
  const weighted = [...groups.values()].map((members) => ({
    members,
    first: order.get(members[0]),
    weight: members.reduce((total, phase) => total + (weights[phase] ?? 1), 0)
  })).sort((a, b) => b.weight - a.weight || a.first - b.first);
  const shards = Array.from({ length: count }, () => ({ members: [], weight: 0 }));
  for (const group of weighted) {
    const lightest = shards.reduce((best, shard) => shard.weight < best.weight ? shard : best);
    lightest.members.push(...group.members);
    lightest.weight += group.weight;
  }
  return shards.map(shard => shard.members.sort((a, b) => order.get(a) - order.get(b)));
}

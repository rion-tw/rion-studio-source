const PASSING_PHASE_STATUSES = new Set(["EXPECTED_FORCE_TERMINATION", "PASS"]);

function requireProfile(manifest, profileName) {
  const profile = manifest.profiles?.[profileName];
  if (!profile) throw new Error(`Unknown desktop E2E profile: ${profileName}`);
  return profile;
}

export function resolveDesktopE2eProfile(manifest, profileName) {
  const visiting = new Set();
  const resolved = new Map();

  function visit(name) {
    const cached = resolved.get(name);
    if (cached) return cached;
    if (visiting.has(name)) {
      throw new Error(`Desktop E2E profile inheritance cycle includes ${name}`);
    }
    visiting.add(name);
    const profile = requireProfile(manifest, name);
    const parent = profile.extends === undefined
      ? { names: [], phases: [], specs: [] }
      : visit(profile.extends);
    const result = {
      names: [...parent.names, name],
      phases: [...parent.phases, ...(profile.phases ?? [])],
      specs: [...parent.specs, ...(profile.specs ?? [])]
    };
    visiting.delete(name);
    resolved.set(name, result);
    return result;
  }

  return visit(profileName);
}

export function journeysForDesktopE2eProfile(manifest, profileName) {
  const profileNames = new Set(resolveDesktopE2eProfile(manifest, profileName).names);
  return (manifest.journeys ?? []).filter((journey) =>
    journey.status === "automated" && profileNames.has(journey.profile)
  );
}

export function aggregateDesktopE2eJourneyVerdicts(
  manifest,
  profileName,
  phaseResults
) {
  const statusByPhase = new Map(
    phaseResults.map((result) => [result.phase, result.status])
  );
  return journeysForDesktopE2eProfile(manifest, profileName).map((journey) => {
    const phases = journey.phases ?? [];
    const statuses = phases.map((phase) => statusByPhase.get(phase));
    let status = "NOT_RUN";
    if (statuses.includes("FAIL")) status = "FAIL";
    else if (statuses.includes("BLOCKED")) status = "BLOCKED";
    else if (
      statuses.length > 0 &&
      statuses.every((phaseStatus) => PASSING_PHASE_STATUSES.has(phaseStatus))
    ) {
      status = "PASS";
    }
    return {
      id: journey.id,
      phases,
      status
    };
  });
}

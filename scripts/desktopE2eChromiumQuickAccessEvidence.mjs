function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function sameValue(left, right) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
      );
    }
    return value;
  };
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function validateChromiumQuickAccessSqliteEvidence(phase, entities, settings) {
  const roles = entities.roles.filter(
    (role) => role.name === "Chromium Entity Role Edited"
  );
  requireEvidence(
    roles.length === 1,
    `${phase}: expected the exact Chromium entity Role used by Quick Access`
  );
  const preferences = settings.find(
    (setting) => setting.key === "quickAccessPreferences"
  )?.payload;
  requireEvidence(
    preferences && Array.isArray(preferences.pinnedItems)
      && Array.isArray(preferences.recentItems),
    `${phase}: persisted Quick Access preferences are missing or malformed`
  );
  const roleItem = { kind: "role", id: roles[0].id };
  const persistenceMatches = phase === "chromium-quick-access-seed"
    ? sameValue(preferences.pinnedItems, [roleItem])
      && sameValue(preferences.recentItems[0], roleItem)
      && preferences.recentItems.filter((item) => sameValue(item, roleItem)).length === 1
    : preferences.pinnedItems.length === 0 && preferences.recentItems.length === 0;
  requireEvidence(
    persistenceMatches,
    `${phase}: Quick Access pin/recent persistence does not match visible actions`
  );
  return {
    pinnedItems: preferences.pinnedItems,
    recentItems: preferences.recentItems,
    roleId: roles[0].id,
    restartAndClearVerified: phase === "chromium-quick-access-restart"
  };
}

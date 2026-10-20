import {
  chromiumJourneyPhaseDependencies,
  chromiumJourneyPhaseNamespaces
} from "./desktopE2eChromiumJourneyEvidence.mjs";

// Phases a focused `--phase` run must also execute, and the user-data namespace
// each phase shares. Desktop E2E sharding keeps both relationships on one runner.
const chromiumAppCrudFocusedDependencies = [
  "chromium-entity-persistence-seed",
  "chromium-entity-persistence-restart",
  "chromium-workspace-web-slot-seed",
  "chromium-workspace-web-slot-restart",
  "chromium-workspace-web-fullscreen-seed",
  "chromium-workspace-web-fullscreen-restart",
  "chromium-fullscreen-toolbar-seed",
  "chromium-fullscreen-toolbar-restart",
  "chromium-quick-access-seed",
  "chromium-quick-access-restart",
  "chromium-settings-persistence-seed",
  "chromium-settings-persistence-restart",
  "chromium-macro-ui-seed",
  "chromium-macro-ui-restart",
  "chromium-macro-native-effect"
];
export const focusedPhaseDependencies = new Map([
  ["chromium-graphics-settings-restart", ["chromium-graphics-settings-seed"]],
  [
    "chromium-app-crud-mutations",
    chromiumAppCrudFocusedDependencies
  ],
  [
    "chromium-app-crud-cleanup",
    [
      ...chromiumAppCrudFocusedDependencies,
      "chromium-workspace-gap-dividers-seed",
      "chromium-workspace-gap-dividers-restart",
      "chromium-app-crud-mutations"
    ]
  ],
  [
    "chromium-app-crud-final-restart",
    [
      ...chromiumAppCrudFocusedDependencies,
      "chromium-app-crud-mutations",
      "chromium-app-crud-cleanup"
    ]
  ],
  ["chromium-game-crud-restart", ["chromium-game-crud-seed"]],
  ["chromium-game-window-ui-restart", ["chromium-game-window-ui-seed"]],
  [
    "chromium-fullscreen-toolbar-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-fullscreen-toolbar-restart",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart", "chromium-fullscreen-toolbar-seed"]
  ],
  [
    "chromium-workspace-gap-dividers-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-workspace-gap-dividers-restart",
    [
      "chromium-entity-persistence-seed",
      "chromium-entity-persistence-restart",
      "chromium-workspace-gap-dividers-seed"
    ]
  ],
  ...chromiumJourneyPhaseDependencies,
  ["chromium-entity-persistence-restart", ["chromium-entity-persistence-seed"]],
  [
    "chromium-quick-access-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-quick-access-restart",
    [
      "chromium-entity-persistence-seed",
      "chromium-entity-persistence-restart",
      "chromium-quick-access-seed"
    ]
  ],
  ["chromium-quit-guard-restart", ["chromium-quit-guard-seed"]],
  ["chromium-role-session-isolation-restart", ["chromium-role-session-isolation-seed"]],
  ["chromium-role-session-reset-restart", ["chromium-role-session-reset-seed"]],
  ["chromium-role-session-upgrade-restart", ["chromium-role-session-upgrade-seed"]],
  ["chromium-system-settings-restart", ["chromium-system-settings"]],
  ["chromium-chrome-profile-import-restart", ["chromium-chrome-profile-import-seed"]]
]);
focusedPhaseDependencies.set("chromium-extensions-restart", ["chromium-extensions-seed"]);

export const phaseNamespaces = new Map([
  ["chromium-graphics-settings-seed", "chromium-graphics-settings-lifecycle"],
  ["chromium-graphics-settings-restart", "chromium-graphics-settings-lifecycle"],
  ["chromium-app-crud-mutations", "chromium-entity-persistence-lifecycle"],
  ["chromium-app-crud-cleanup", "chromium-entity-persistence-lifecycle"],
  ["chromium-app-crud-final-restart", "chromium-entity-persistence-lifecycle"],
  ["chromium-game-crud-seed", "chromium-game-crud-lifecycle"],
  ["chromium-game-crud-restart", "chromium-game-crud-lifecycle"],
  ["chromium-game-window-ui-seed", "chromium-game-window-ui-lifecycle"],
  ["chromium-game-window-ui-restart", "chromium-game-window-ui-lifecycle"],
  ["chromium-workspace-gap-dividers-seed", "chromium-entity-persistence-lifecycle"],
  ["chromium-workspace-gap-dividers-restart", "chromium-entity-persistence-lifecycle"],
  ...chromiumJourneyPhaseNamespaces,
  ["chromium-entity-persistence-seed", "chromium-entity-persistence-lifecycle"],
  ["chromium-entity-persistence-restart", "chromium-entity-persistence-lifecycle"],
  ["chromium-quick-access-seed", "chromium-entity-persistence-lifecycle"],
  ["chromium-quick-access-restart", "chromium-entity-persistence-lifecycle"],
  ["chromium-quit-guard-seed", "chromium-quit-guard-lifecycle"],
  ["chromium-quit-guard-restart", "chromium-quit-guard-lifecycle"],
  ["chromium-role-session-isolation-seed", "chromium-role-session-isolation-lifecycle"],
  ["chromium-role-session-isolation-restart", "chromium-role-session-isolation-lifecycle"],
  ["chromium-role-session-upgrade-seed", "chromium-role-session-upgrade-lifecycle"],
  ["chromium-role-session-upgrade-restart", "chromium-role-session-upgrade-lifecycle"],
  ["chromium-role-session-reset-seed", "chromium-role-session-reset-lifecycle"],
  ["chromium-role-session-reset-restart", "chromium-role-session-reset-lifecycle"],
  ["chromium-system-settings", "chromium-system-settings-lifecycle"],
  ["chromium-system-settings-restart", "chromium-system-settings-lifecycle"],
  ["chromium-chrome-profile-import-seed", "chromium-chrome-profile-import-lifecycle"],
  ["chromium-chrome-profile-import-restart", "chromium-chrome-profile-import-lifecycle"]
]);
phaseNamespaces.set("chromium-extensions-seed", "chromium-extensions");
phaseNamespaces.set("chromium-extensions-restart", "chromium-extensions");

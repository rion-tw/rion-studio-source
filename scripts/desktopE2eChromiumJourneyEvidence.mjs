import {
  chromiumAppRecoveryPhaseDependencies,
  chromiumAppRecoveryPhaseNamespaces,
  isChromiumAppRecoveryPhase,
  validateChromiumAppRecoveryRuntimeEvidence,
  validateChromiumAppRecoverySqliteEvidence
} from "./desktopE2eChromiumAppRecoveryEvidence.mjs";
import {
  chromiumFullscreenToolbarPhaseDependencies,
  chromiumFullscreenToolbarPhaseNamespaces,
  isChromiumFullscreenToolbarPhase,
  validateChromiumFullscreenToolbarRuntimeEvidence,
  validateChromiumFullscreenToolbarSqliteEvidence
} from "./desktopE2eChromiumFullscreenToolbarEvidence.mjs";
import {
  validateChromiumGameWindowRuntimeEvidence,
  validateChromiumGameWindowSqliteEvidence
} from "./desktopE2eChromiumGameWindowEvidence.mjs";
import {
  chromiumMacroBackgroundTabPhaseDependencies,
  chromiumMacroBackgroundTabPhaseNamespaces,
  isChromiumMacroBackgroundTabPhase,
  validateChromiumMacroBackgroundTabRuntimeEvidence,
  validateChromiumMacroBackgroundTabSqliteEvidence
} from "./desktopE2eChromiumMacroBackgroundTabEvidence.mjs";
import {
  chromiumMacroCutoverPhaseDependencies,
  chromiumMacroCutoverPhaseNamespaces,
  isChromiumMacroCutoverPhase,
  validateChromiumMacroCutoverRuntimeEvidence,
  validateChromiumMacroCutoverSqliteEvidence
} from "./desktopE2eChromiumMacroCutoverEvidence.mjs";
import {
  chromiumMacroNativeEffectPhaseDependencies,
  chromiumMacroNativeEffectPhaseNamespaces,
  isChromiumMacroNativeEffectPhase,
  validateChromiumMacroNativeEffectSqliteEvidence
} from "./desktopE2eChromiumMacroNativeEffectEvidence.mjs";
import {
  chromiumMacroStandbyPhaseDependencies,
  chromiumMacroStandbyPhaseNamespaces,
  isChromiumMacroStandbyPhase,
  validateChromiumMacroStandbyRuntimeEvidence,
  validateChromiumMacroStandbySqliteEvidence
} from "./desktopE2eChromiumMacroStandbyEvidence.mjs";
import {
  chromiumMacroUiPhaseDependencies,
  chromiumMacroUiPhaseNamespaces,
  isChromiumMacroUiPhase,
  validateChromiumMacroUiSqliteEvidence
} from "./desktopE2eChromiumMacroUiEvidence.mjs";
import {
  chromiumRecoveryParityPhaseDependencies,
  chromiumRecoveryParityPhaseNamespaces,
  isChromiumRecoveryParityPhase,
  validateChromiumRecoveryParityRuntimeEvidence,
  validateChromiumRecoveryParitySqliteEvidence
} from "./desktopE2eChromiumRecoveryParityEvidence.mjs";
import {
  chromiumSettingsPersistencePhaseDependencies,
  chromiumSettingsPersistencePhaseNamespaces,
  isChromiumSettingsPersistencePhase,
  validateChromiumSettingsPersistenceSqliteEvidence
} from "./desktopE2eChromiumSettingsPersistenceEvidence.mjs";
import {
  chromiumTabsPhaseDependencies,
  chromiumTabsPhaseNamespaces,
  isChromiumTabsPhase,
  validateChromiumTabsRuntimeEvidence,
  validateChromiumTabsSqliteEvidence
} from "./desktopE2eChromiumTabsEvidence.mjs";
import {
  chromiumWorkspaceWebPhaseDependencies,
  chromiumWorkspaceWebPhaseNamespaces,
  isChromiumWorkspaceWebPhase,
  validateChromiumWorkspaceWebRuntimeEvidence,
  validateChromiumWorkspaceWebSqliteEvidence
} from "./desktopE2eChromiumWorkspaceWebEvidence.mjs";
import {
  chromiumWorkspaceWebFullscreenPhaseDependencies,
  chromiumWorkspaceWebFullscreenPhaseNamespaces,
  isChromiumWorkspaceWebFullscreenPhase,
  validateChromiumWorkspaceWebFullscreenRuntimeEvidence,
  validateChromiumWorkspaceWebFullscreenSqliteEvidence
} from "./desktopE2eChromiumWorkspaceWebFullscreenEvidence.mjs";
import {
  chromiumWorkspaceCutoverPhaseDependencies,
  chromiumWorkspaceCutoverPhaseNamespaces,
  isChromiumWorkspaceCutoverPhase,
  validateChromiumWorkspaceCutoverRuntimeEvidence,
  validateChromiumWorkspaceCutoverSqliteEvidence
} from "./desktopE2eChromiumWorkspaceCutoverEvidence.mjs";

export const chromiumJourneyPhaseDependencies = Object.freeze([
  ...chromiumFullscreenToolbarPhaseDependencies,
  ...chromiumMacroUiPhaseDependencies,
  ...chromiumMacroNativeEffectPhaseDependencies,
  ...chromiumMacroBackgroundTabPhaseDependencies,
  ...chromiumMacroStandbyPhaseDependencies,
  ...chromiumMacroCutoverPhaseDependencies,
  ...chromiumSettingsPersistencePhaseDependencies,
  ...chromiumTabsPhaseDependencies,
  ...chromiumWorkspaceWebPhaseDependencies,
  ...chromiumWorkspaceWebFullscreenPhaseDependencies,
  ...chromiumWorkspaceCutoverPhaseDependencies,
  ...chromiumRecoveryParityPhaseDependencies,
  ...chromiumAppRecoveryPhaseDependencies
]);

export const chromiumJourneyPhaseNamespaces = Object.freeze([
  ...chromiumFullscreenToolbarPhaseNamespaces,
  ...chromiumMacroUiPhaseNamespaces,
  ...chromiumMacroNativeEffectPhaseNamespaces,
  ...chromiumMacroBackgroundTabPhaseNamespaces,
  ...chromiumMacroStandbyPhaseNamespaces,
  ...chromiumMacroCutoverPhaseNamespaces,
  ...chromiumSettingsPersistencePhaseNamespaces,
  ...chromiumTabsPhaseNamespaces,
  ...chromiumWorkspaceWebPhaseNamespaces,
  ...chromiumWorkspaceWebFullscreenPhaseNamespaces,
  ...chromiumWorkspaceCutoverPhaseNamespaces,
  ...chromiumRecoveryParityPhaseNamespaces,
  ...chromiumAppRecoveryPhaseNamespaces
]);

export async function validateChromiumJourneyRuntimeEvidence(input) {
  return await validateChromiumMacroBackgroundTabRuntimeEvidence(input) ??
    await validateChromiumMacroCutoverRuntimeEvidence(input) ??
    await validateChromiumMacroStandbyRuntimeEvidence(input) ??
    await validateChromiumRecoveryParityRuntimeEvidence(input) ??
    await validateChromiumAppRecoveryRuntimeEvidence(input) ??
    await validateChromiumTabsRuntimeEvidence(input) ??
    await validateChromiumFullscreenToolbarRuntimeEvidence(input) ??
    await validateChromiumWorkspaceWebFullscreenRuntimeEvidence(input) ??
    await validateChromiumWorkspaceCutoverRuntimeEvidence(input) ??
    await validateChromiumWorkspaceWebRuntimeEvidence(input) ??
    await validateChromiumGameWindowRuntimeEvidence(input);
}

export function validateChromiumJourneySqliteEvidence(input) {
  const { entities, phase, phaseDirectory, settings } = input;
  if (phase === "chromium-game-window-ui-seed" ||
      phase === "chromium-game-window-ui-restart") {
    return validateChromiumGameWindowSqliteEvidence(phase, entities);
  }
  if (isChromiumFullscreenToolbarPhase(phase)) {
    return validateChromiumFullscreenToolbarSqliteEvidence(phase, entities, settings);
  }
  if (isChromiumWorkspaceWebPhase(phase)) {
    return validateChromiumWorkspaceWebSqliteEvidence(phase, entities, settings);
  }
  if (isChromiumWorkspaceWebFullscreenPhase(phase)) {
    return validateChromiumWorkspaceWebFullscreenSqliteEvidence(
      phase,
      entities,
      settings
    );
  }
  if (isChromiumWorkspaceCutoverPhase(phase)) {
    return validateChromiumWorkspaceCutoverSqliteEvidence(
      phase,
      entities,
      settings
    );
  }
  if (isChromiumSettingsPersistencePhase(phase)) {
    return validateChromiumSettingsPersistenceSqliteEvidence(phase, entities, settings);
  }
  if (isChromiumMacroUiPhase(phase)) {
    return validateChromiumMacroUiSqliteEvidence(phase, entities, settings);
  }
  if (isChromiumMacroNativeEffectPhase(phase)) {
    return validateChromiumMacroNativeEffectSqliteEvidence(phase, entities, settings);
  }
  if (isChromiumMacroBackgroundTabPhase(phase)) {
    return validateChromiumMacroBackgroundTabSqliteEvidence(input);
  }
  if (isChromiumMacroStandbyPhase(phase)) {
    return validateChromiumMacroStandbySqliteEvidence(input);
  }
  if (isChromiumMacroCutoverPhase(phase)) {
    return validateChromiumMacroCutoverSqliteEvidence(input);
  }
  if (isChromiumTabsPhase(phase)) {
    return validateChromiumTabsSqliteEvidence(phase, entities, settings);
  }
  if (isChromiumAppRecoveryPhase(phase)) {
    return validateChromiumAppRecoverySqliteEvidence({
      entities,
      phase,
      phaseDirectory,
      settings
    });
  }
  if (isChromiumRecoveryParityPhase(phase)) {
    return validateChromiumRecoveryParitySqliteEvidence(input);
  }
  return undefined;
}

import type { RuntimeWindowPreferencesRecord } from "../../shared/generated";
import { fail, hostError } from "./macosAppKitRuntimeHostSupport";

export interface MacosAppKitRuntimeWindowPreferencesHost {
  readonly applyFullscreenPolicy: (value: boolean) => void;
  readonly applyTabClosePolicy: (value: boolean) => void;
  readonly fenceMatches: () => boolean;
  readonly poison: (error: unknown) => void;
  readonly quarantine: (error: unknown) => void;
}

interface AppliedPreferenceHost {
  readonly host: MacosAppKitRuntimeWindowPreferencesHost;
  fullscreenPolicy: boolean;
  tabClosePolicy: boolean;
}

/** Applies one Core preference revision transactionally to every exact host. */
export function applyMacosAppKitRuntimeWindowPreferences(input: Readonly<{
  hosts: readonly MacosAppKitRuntimeWindowPreferencesHost[];
  preferences: RuntimeWindowPreferencesRecord;
  previous: RuntimeWindowPreferencesRecord;
}>): RuntimeWindowPreferencesRecord {
  const { preferences, previous } = input;
  if (
    !preferences ||
    typeof preferences.alwaysHideTabCloseButton !== "boolean" ||
    typeof preferences.alwaysShowToolbarInFullScreen !== "boolean" ||
    typeof preferences.restoreGameWindowsOnStartup !== "boolean"
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_PREFERENCES_INVALID",
      "Core supplied invalid AppKit runtime-window preferences."
    );
  }
  const next = Object.freeze({ ...preferences });
  const applied: AppliedPreferenceHost[] = [];
  try {
    for (const host of input.hosts) {
      const stage = { host, fullscreenPolicy: false, tabClosePolicy: false };
      applied.push(stage);
      stage.fullscreenPolicy = true;
      host.applyFullscreenPolicy(next.alwaysShowToolbarInFullScreen);
      requireCurrentFence(host, "changed");
      stage.tabClosePolicy = true;
      host.applyTabClosePolicy(next.alwaysHideTabCloseButton);
      requireCurrentFence(host, "changed");
    }
    return next;
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const stage of applied.reverse()) {
      if (stage.tabClosePolicy) {
        try {
          stage.host.applyTabClosePolicy(previous.alwaysHideTabCloseButton);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
          stage.host.poison(rollbackError);
        }
      }
      if (stage.fullscreenPolicy) {
        try {
          stage.host.applyFullscreenPolicy(
            previous.alwaysShowToolbarInFullScreen
          );
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
          stage.host.poison(rollbackError);
        }
      }
      if (!stage.host.fenceMatches()) {
        const stale = hostError(
          "ELECTRON_MACOS_APPKIT_PREFERENCES_FENCE_STALE",
          "The AppKit preference projection could not restore its exact window fence."
        );
        rollbackFailures.push(stale);
        stage.host.quarantine(stale);
      }
    }
    if (rollbackFailures.length > 0) {
      throw hostError(
        "ELECTRON_MACOS_APPKIT_PREFERENCES_ROLLBACK_FAILED",
        "AppKit runtime-window preferences could not be compensated exactly."
      );
    }
    throw error;
  }
}

function requireCurrentFence(
  host: MacosAppKitRuntimeWindowPreferencesHost,
  outcome: "changed"
): void {
  if (host.fenceMatches()) return;
  fail(
    "ELECTRON_MACOS_APPKIT_PREFERENCES_FENCE_STALE",
    `The AppKit preference projection ${outcome} its exact window fence.`
  );
}

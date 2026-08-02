import { useCallback, useEffect, useState } from "react";

import { FIRST_RUN_ONBOARDING_STORAGE_KEY } from "../app/constants";
import type { Role } from "../../../shared/types";

const FIRST_RUN_ONBOARDING_VERSION = 1;

export interface FirstRunOnboardingProgress {
  version: 1;
  state: "in_progress";
  gameId?: string;
  roleId?: string;
}

export type FirstRunOnboardingRecord =
  | FirstRunOnboardingProgress
  | { version: 1; state: "completed" | "skipped" };

const EMPTY_PROGRESS: FirstRunOnboardingProgress = {
  version: FIRST_RUN_ONBOARDING_VERSION,
  state: "in_progress"
};

export function readFirstRunOnboardingRecord(
  storage: Pick<Storage, "getItem"> = window.localStorage
): FirstRunOnboardingRecord | null {
  const stored = storage.getItem(FIRST_RUN_ONBOARDING_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    const value = JSON.parse(stored) as Record<string, unknown>;
    if (value.version !== FIRST_RUN_ONBOARDING_VERSION) {
      return null;
    }
    if (value.state === "completed" || value.state === "skipped") {
      return { version: FIRST_RUN_ONBOARDING_VERSION, state: value.state };
    }
    if (value.state !== "in_progress") {
      return null;
    }

    return {
      ...EMPTY_PROGRESS,
      ...(typeof value.gameId === "string" && value.gameId.trim() ? { gameId: value.gameId } : {}),
      ...(typeof value.roleId === "string" && value.roleId.trim() ? { roleId: value.roleId } : {})
    };
  } catch {
    return null;
  }
}

function writeFirstRunOnboardingRecord(record: FirstRunOnboardingRecord): void {
  window.localStorage.setItem(FIRST_RUN_ONBOARDING_STORAGE_KEY, JSON.stringify(record));
}

export function useFirstRunOnboarding({
  enabled,
  roles
}: {
  enabled: boolean;
  roles: Role[];
}) {
  const [persistedRecord, setPersistedRecord] = useState<FirstRunOnboardingRecord | null>(
    readFirstRunOnboardingRecord
  );
  const [sessionProgress, setSessionProgress] = useState<FirstRunOnboardingProgress | null>(() =>
    persistedRecord?.state === "in_progress" ? persistedRecord : null
  );
  const [isSuccessPresented, setIsSuccessPresented] = useState(false);

  const persist = useCallback((record: FirstRunOnboardingRecord): void => {
    writeFirstRunOnboardingRecord(record);
    setPersistedRecord(record);
  }, []);

  const updateProgress = useCallback((patch: Partial<Pick<FirstRunOnboardingProgress, "gameId" | "roleId">>): void => {
    const next = { ...(sessionProgress ?? EMPTY_PROGRESS), ...patch };
    persist(next);
    setSessionProgress(next);
  }, [persist, sessionProgress]);

  const skip = useCallback((): void => {
    persist({ version: FIRST_RUN_ONBOARDING_VERSION, state: "skipped" });
    setSessionProgress(null);
    setIsSuccessPresented(false);
  }, [persist]);

  const complete = useCallback((): void => {
    persist({ version: FIRST_RUN_ONBOARDING_VERSION, state: "completed" });
    setIsSuccessPresented(true);
  }, [persist]);

  const dismissSuccess = useCallback((): void => {
    setIsSuccessPresented(false);
    setSessionProgress(null);
  }, []);

  useEffect(() => {
    if (!enabled || persistedRecord !== null) {
      return;
    }

    if (roles.length > 0) {
      persist({ version: FIRST_RUN_ONBOARDING_VERSION, state: "completed" });
      return;
    }

    const nextProgress = { ...EMPTY_PROGRESS };
    persist(nextProgress);
    setSessionProgress(nextProgress);
  }, [enabled, persist, persistedRecord, roles.length]);

  const isVisible = enabled && (
    isSuccessPresented
    || sessionProgress !== null
    || (persistedRecord === null && roles.length === 0)
  );

  return {
    complete,
    dismissSuccess,
    isSuccessPresented,
    isVisible,
    progress: sessionProgress ?? EMPTY_PROGRESS,
    skip,
    updateProgress
  };
}

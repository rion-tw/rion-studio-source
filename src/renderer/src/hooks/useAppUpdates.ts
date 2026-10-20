import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppUpdateStatus } from "../../../shared/types";
import { useGuardedApplicationAction } from "../components/applicationQuitGuardRegistry";

interface UseAppUpdatesOptions {
  /** Automatic checks start only after the legal disclosures were accepted. */
  automaticChecks?: boolean;
  enabled: boolean;
  onError: (error: unknown) => void;
}

interface UseAppUpdatesResult {
  appVersion: string;
  isBusy: boolean;
  status: AppUpdateStatus | null;
  checkForUpdates: () => Promise<void>;
  setAutoUpdateEnabled: (enabled: boolean) => Promise<void>;
  openUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: () => Promise<void>;
}

export function useAppUpdates({
  automaticChecks = false,
  enabled,
  onError
}: UseAppUpdatesOptions): UseAppUpdatesResult {
  const [appVersion, setAppVersion] = useState("");
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const checkInFlightRef = useRef(false);
  const requestGuardedAction = useGuardedApplicationAction();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let isDisposed = false;

    void Promise.all([window.rionStudio.getAppVersion(), window.rionStudio.getUpdateStatus()])
      .then(([version, updateStatus]) => {
        if (isDisposed) {
          return;
        }

        setAppVersion(version);
        setStatus(updateStatus);
      })
      .catch(onError);

    const unsubscribe = window.rionStudio.onUpdateStatusChanged((nextStatus) => {
      setStatus(nextStatus);
      setAppVersion(nextStatus.currentVersion);
    });

    return () => {
      isDisposed = true;
      unsubscribe();
    };
  }, [enabled, onError]);

  // Automatic updates follow application events: this window opening and
  // every return to it. Core starts a check only when one is due.
  useEffect(() => {
    if (!enabled || !automaticChecks) {
      return;
    }
    const checkIfDue = (): void => {
      void window.rionStudio.checkForUpdatesIfDue().catch(() => undefined);
    };
    checkIfDue();
    window.addEventListener("focus", checkIfDue);
    return () => window.removeEventListener("focus", checkIfDue);
  }, [automaticChecks, enabled]);

  const checkForUpdates = useCallback(async () => {
    if (!enabled || checkInFlightRef.current) {
      return;
    }

    checkInFlightRef.current = true;
    try {
      setStatus(await window.rionStudio.checkForUpdates());
    } catch (error) {
      onError(error);
    } finally {
      checkInFlightRef.current = false;
    }
  }, [enabled, onError]);

  const setAutoUpdateEnabled = useCallback(async (autoUpdateEnabled: boolean) => {
    if (!enabled) {
      return;
    }

    try {
      setStatus(await window.rionStudio.setAutoUpdateEnabled(autoUpdateEnabled));
      // Turning automatic updates on is itself the event for a due check.
      if (autoUpdateEnabled && automaticChecks) {
        void window.rionStudio.checkForUpdatesIfDue().catch(() => undefined);
      }
    } catch (error) {
      onError(error);
    }
  }, [automaticChecks, enabled, onError]);

  const installDownloadedUpdate = useCallback(async () => {
    if (!enabled) {
      return;
    }

    try {
      await requestGuardedAction(() => window.rionStudio.installDownloadedUpdate());
    } catch (error) {
      onError(error);
    }
  }, [enabled, onError, requestGuardedAction]);

  const openUpdateDownload = useCallback(async () => {
    if (!enabled) {
      return;
    }

    try {
      await window.rionStudio.openUpdateDownload();
    } catch (error) {
      onError(error);
    }
  }, [enabled, onError]);

  const isBusy = useMemo(() => [
    "checking",
    "downloading",
    "preparing",
    "installing",
    "draining",
    "restart_pending"
  ].includes(status?.state ?? ""), [status?.state]);

  return {
    appVersion,
    isBusy,
    status,
    checkForUpdates,
    setAutoUpdateEnabled,
    openUpdateDownload,
    installDownloadedUpdate
  };
}

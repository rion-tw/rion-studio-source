import { useCallback, useEffect, useMemo, useState } from "react";

import type { AppUpdateStatus } from "../../../shared/types";

interface UseAppUpdatesOptions {
  enabled: boolean;
  onError: (error: unknown) => void;
}

interface UseAppUpdatesResult {
  appVersion: string;
  isBusy: boolean;
  status: AppUpdateStatus | null;
  checkForUpdates: () => Promise<void>;
  openUpdateDownload: () => Promise<void>;
  installDownloadedUpdate: () => Promise<void>;
}

export function useAppUpdates({ enabled, onError }: UseAppUpdatesOptions): UseAppUpdatesResult {
  const [appVersion, setAppVersion] = useState("");
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);

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

  const checkForUpdates = useCallback(async () => {
    if (!enabled) {
      return;
    }

    try {
      setStatus(await window.rionStudio.checkForUpdates());
    } catch (error) {
      onError(error);
    }
  }, [enabled, onError]);

  const installDownloadedUpdate = useCallback(async () => {
    if (!enabled) {
      return;
    }

    try {
      await window.rionStudio.installDownloadedUpdate();
    } catch (error) {
      onError(error);
    }
  }, [enabled, onError]);

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

  const isBusy = useMemo(() => status?.state === "checking" || status?.state === "downloading", [status?.state]);

  return {
    appVersion,
    isBusy,
    status,
    checkForUpdates,
    openUpdateDownload,
    installDownloadedUpdate
  };
}

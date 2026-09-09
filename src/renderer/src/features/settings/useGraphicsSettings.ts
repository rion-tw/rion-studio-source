import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphicsSettingsRecord, GraphicsSettingsSnapshotRecord, GraphicsStatusRecord } from "../../../../shared/generated";
import { graphicsSettingsEqual } from "../../../../shared/graphicsSettings";
import { useGuardedApplicationAction } from "../../components/applicationQuitGuardRegistry";

export function useGraphicsSettings(onError: (error: unknown) => void) {
  const [saved, setSaved] = useState<GraphicsSettingsSnapshotRecord | null>(null);
  const [status, setStatus] = useState<GraphicsStatusRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const requestAction = useGuardedApplicationAction();
  const acceptSettings = useCallback((next: GraphicsSettingsSnapshotRecord) => {
    if (mounted.current) setSaved((current) => !current || next.revision >= current.revision ? next : current);
  }, []);
  const acceptStatus = useCallback((next: GraphicsStatusRecord) => {
    if (mounted.current) setStatus((current) => !current || next.sequence >= current.sequence ? next : current);
  }, []);
  const reportError = useCallback((failure: unknown) => {
    if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    onError(failure);
  }, [onError]);
  useEffect(() => {
    mounted.current = true;
    const api = window.rionStudio;
    if (!api?.getGraphicsStatus) return () => { mounted.current = false; };
    let active = true;
    const offStatus = api.onGraphicsStatusChanged(acceptStatus);
    const offSettings = api.onGraphicsSettingsChanged(acceptSettings);
    void api.getGraphicsStatus(true).then(async (next) => {
      if (!active) return;
      acceptStatus(next);
      if (next.supported) {
        const snapshot = await api.getGraphicsSettings();
        if (active) acceptSettings(snapshot);
      }
    }).catch((failure: unknown) => { if (active) reportError(failure); });
    return () => { active = false; mounted.current = false; offStatus(); offSettings(); };
  }, [acceptSettings, acceptStatus, reportError]);
  async function save(settings: GraphicsSettingsRecord): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(null);
    try { acceptSettings(await window.rionStudio.updateGraphicsSettings(settings)); }
    catch (failure) { reportError(failure); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function refresh(): Promise<void> {
    setRefreshing(true);
    try { acceptStatus(await window.rionStudio.getGraphicsStatus(true)); }
    catch (failure) { reportError(failure); }
    finally { if (mounted.current) setRefreshing(false); }
  }
  async function restart(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await requestAction(() => window.rionStudio.restartApplication()); }
    catch (failure) { reportError(failure); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const pendingRestart = Boolean(saved && status?.appliedSettings &&
    !graphicsSettingsEqual(saved.settings, status.appliedSettings));
  return { saved, status, busy, error, refreshing, pendingRestart, save, refresh, restart, reportError };
}

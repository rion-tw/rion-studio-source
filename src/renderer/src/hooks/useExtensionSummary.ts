import { useEffect, useState } from "react";
import type { ExtensionSnapshotRecord } from "../../../shared/generated";

const unavailable = { available: false, count: 0 };

/** The sidebar follows Core snapshots even while the Extensions route is unmounted. */
export function useExtensionSummary(enabled: boolean) {
  const [summary, setSummary] = useState(unavailable);
  useEffect(() => {
    const api = window.rionStudio;
    if (!enabled || !api?.extensions) return;
    let active = true;
    let revision = -1;
    const apply = (snapshot: ExtensionSnapshotRecord) => {
      if (!active || snapshot.revision <= revision) return;
      revision = snapshot.revision;
      // Pending-removal entries still appear in the catalogue and remain counted until cleanup.
      setSummary({ available: true, count: snapshot.installed.length });
    };
    const unsubscribe = api.onExtensionsChanged?.(apply);
    void api.extensions({ type: "snapshot" }).then(result => apply(result.snapshot), () => {
      if (active && revision < 0) setSummary(unavailable);
    });
    return () => { active = false; unsubscribe?.(); };
  }, [enabled]);
  return enabled ? summary : unavailable;
}

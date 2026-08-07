import { useCallback, useEffect, useRef, useState } from "react";

import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "../../../shared/legal";
import type { LegalAcceptanceStatus } from "../../../shared/types";
import { withTimeout } from "../app/withTimeout";

export const LEGAL_STATUS_TIMEOUT_MS = 15_000;

export function useLegalAcceptance(enabled: boolean) {
  const [status, setStatus] = useState<LegalAcceptanceStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isAccepting, setIsAccepting] = useState(false);
  const statusRequestRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    if (!enabled) {
      return;
    }

    const request = ++statusRequestRef.current;
    setStatus(null);
    setError(null);
    try {
      // event-topology-exception: renderer-bounded-bridge-wait
      const nextStatus = await withTimeout(
        window.rionStudio.getLegalAcceptanceStatus(),
        LEGAL_STATUS_TIMEOUT_MS,
        "Legal acceptance status did not load within 15 seconds."
      );
      if (statusRequestRef.current === request) {
        setStatus(nextStatus);
      }
    } catch (nextError) {
      if (statusRequestRef.current === request) {
        setError(nextError);
      }
    }
  }, [enabled]);

  useEffect(() => {
    void reload();

    return () => {
      statusRequestRef.current += 1;
    };
  }, [reload]);

  const accept = useCallback(async (): Promise<void> => {
    setIsAccepting(true);
    setError(null);
    try {
      const nextStatus = await window.rionStudio.acceptLegalDocuments({
        fairUseVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.fairUse,
        privacyVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.privacy,
        termsVersion: CURRENT_LEGAL_DOCUMENT_VERSIONS.terms
      });
      setStatus(nextStatus);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setIsAccepting(false);
    }
  }, []);

  return {
    accept,
    error,
    isAccepting,
    isLoading: enabled && status === null && error === null,
    reload,
    status
  };
}

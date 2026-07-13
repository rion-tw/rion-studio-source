import { useCallback, useEffect, useState } from "react";

import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "../../../shared/legal";
import type { LegalAcceptanceStatus } from "../../../shared/types";

export function useLegalAcceptance(enabled: boolean) {
  const [status, setStatus] = useState<LegalAcceptanceStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isAccepting, setIsAccepting] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let isDisposed = false;
    void window.rionStudio
      .getLegalAcceptanceStatus()
      .then((nextStatus) => {
        if (!isDisposed) {
          setStatus(nextStatus);
        }
      })
      .catch((nextError) => {
        if (!isDisposed) {
          setError(nextError);
        }
      });

    return () => {
      isDisposed = true;
    };
  }, [enabled]);

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
    status
  };
}

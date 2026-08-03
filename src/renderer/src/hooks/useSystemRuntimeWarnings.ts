import { useEffect } from "react";

import {
  SYSTEM_RUNTIME_WARNING_EVENT,
  type SystemRuntimeWarningDetail
} from "../app/systemRuntimeReceipt";

export function useSystemRuntimeWarnings(
  setNotice: (notice: string | null) => void
): void {
  useEffect(() => {
    const handleWarning = (event: Event): void => {
      setNotice((event as CustomEvent<SystemRuntimeWarningDetail>).detail.message);
    };
    window.addEventListener(SYSTEM_RUNTIME_WARNING_EVENT, handleWarning);
    return () => window.removeEventListener(SYSTEM_RUNTIME_WARNING_EVENT, handleWarning);
  }, [setNotice]);
}

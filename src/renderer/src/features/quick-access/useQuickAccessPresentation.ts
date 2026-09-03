import { useCallback, useEffect, useRef, useState } from "react";

import type {
  QuickAccessPresentationRequest,
  QuickAccessRequestResolution
} from "../../../../shared/types";

export type QuickAccessCloseReason = QuickAccessRequestResolution;

interface UseQuickAccessPresentationInput {
  enabled: boolean;
  hasBridge: boolean;
  onError: (error: unknown) => void;
}

interface QuickAccessPresentationController {
  isOpen: boolean;
  isManagedRequestActive: () => boolean;
  restoreDomFocusOnClose: boolean;
  close: (reason: QuickAccessCloseReason) => void;
  didClose: () => void;
  openFromMainWindow: () => void;
}

export function hasBlockingQuickAccessDialog(documentValue: Document): boolean {
  return [...documentValue.querySelectorAll("dialog[open], [aria-modal=\"true\"]")]
    .some((element) => !element.matches("[data-testid=\"quick-access-palette\"]"));
}

export function useQuickAccessPresentation({
  enabled,
  hasBridge,
  onError
}: UseQuickAccessPresentationInput): QuickAccessPresentationController {
  const [isOpen, setIsOpen] = useState(false);
  const [restoreDomFocusOnClose, setRestoreDomFocusOnClose] = useState(true);
  const activeRequestIdRef = useRef<string | null>(null);

  const resolveActiveRequest = useCallback((resolution: QuickAccessCloseReason): void => {
    const requestId = activeRequestIdRef.current;
    activeRequestIdRef.current = null;
    if (!requestId || !hasBridge) return;
    void window.rionStudio.resolveQuickAccessRequest(requestId, resolution).catch(onError);
  }, [hasBridge, onError]);

  const close = useCallback((reason: QuickAccessCloseReason): void => {
    const hasGameOrigin = activeRequestIdRef.current !== null;
    setRestoreDomFocusOnClose(reason === "cancel" && !hasGameOrigin);
    setIsOpen(false);
    resolveActiveRequest(reason);
  }, [resolveActiveRequest]);

  const didClose = useCallback((): void => {
    setRestoreDomFocusOnClose(true);
  }, []);

  const isManagedRequestActive = useCallback(
    (): boolean => activeRequestIdRef.current !== null,
    []
  );

  const openFromMainWindow = useCallback((): void => {
    if (!enabled || hasBlockingQuickAccessDialog(document)) return;
    setRestoreDomFocusOnClose(true);
    setIsOpen(true);
  }, [enabled]);

  useEffect(() => {
    if (enabled || !isOpen) return;
    close("ignored");
  }, [close, enabled, isOpen]);

  useEffect(() => {
    if (!hasBridge) return;
    let disposed = false;

    const handleRequest = async (request: QuickAccessPresentationRequest): Promise<void> => {
      if (disposed) return;
      try {
        if (!enabled || hasBlockingQuickAccessDialog(document)) {
          await window.rionStudio.resolveQuickAccessRequest(request.requestId, "ignored");
          return;
        }
        // Fence the physical chord before focusing the launcher. Its remaining
        // native key events must not be consumed again by the main-window
        // shortcut handler and immediately close the managed-origin palette.
        activeRequestIdRef.current = request.requestId;
        const presented = await window.rionStudio.presentQuickAccessRequest(request.requestId);
        if (disposed) {
          if (presented) {
            await window.rionStudio.resolveQuickAccessRequest(request.requestId, "ignored");
          }
          if (activeRequestIdRef.current === request.requestId) {
            activeRequestIdRef.current = null;
          }
          return;
        }
        if (!presented) {
          if (activeRequestIdRef.current === request.requestId) {
            activeRequestIdRef.current = null;
          }
          return;
        }
        setRestoreDomFocusOnClose(true);
        setIsOpen(true);
      } catch (error) {
        if (activeRequestIdRef.current === request.requestId) {
          activeRequestIdRef.current = null;
        }
        await window.rionStudio
          .resolveQuickAccessRequest(request.requestId, "ignored")
          .catch(() => undefined);
        onError(error);
        return;
      }
    };

    const consumePendingRequest = (): void => {
      void window.rionStudio.consumePendingQuickAccessRequest()
        .then((request) => {
          if (request) return handleRequest(request);
        })
        .catch(onError);
    };
    const unsubscribe = window.rionStudio.onQuickAccessRequested(consumePendingRequest);
    consumePendingRequest();

    return () => {
      disposed = true;
      unsubscribe();
      resolveActiveRequest("ignored");
    };
  }, [enabled, hasBridge, onError, resolveActiveRequest]);

  return {
    close,
    didClose,
    isOpen,
    isManagedRequestActive,
    openFromMainWindow,
    restoreDomFocusOnClose
  };
}

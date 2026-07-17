export interface SingleInstanceLifecycleOptions {
  onSecondInstance: (listener: () => void) => void;
  quitSecondaryInstance: () => void;
  requestLock: () => boolean;
  showPrimaryInstance: () => void;
}

export function configureSingleInstanceLifecycle({
  onSecondInstance,
  quitSecondaryInstance,
  requestLock,
  showPrimaryInstance
}: SingleInstanceLifecycleOptions): boolean {
  if (!requestLock()) {
    quitSecondaryInstance();
    return false;
  }

  onSecondInstance(showPrimaryInstance);
  return true;
}

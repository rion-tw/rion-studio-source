import { sendChromiumClick, sendChromiumKey } from "./chromiumWebContentsInput";
import type { RawWindowsChromiumInputHwndProbeReceipt } from "./windowsChromiumInputSurfaceAttachmentCoordinator";
import type {
  LegacyWindowsChromiumInputSurfaceIdentity, WindowsNativeTrustedKeyRequest,
  WindowsNativeTrustedMouseRequest, LegacyWindowsNativeTrustedInputSubmissionBase
} from "./windowsChromiumTrustedInputContract";

interface Owner {
  identity: LegacyWindowsChromiumInputSurfaceIdentity;
  probeRevision: string;
  contents: Parameters<typeof sendChromiumKey>[0];
  probe: () => RawWindowsChromiumInputHwndProbeReceipt;
  viewport: () => { width: number; height: number };
  nowMs: () => number;
}
let dispatchSequence = 0n;

function submit<Value>(owner: Owner,
  request: WindowsNativeTrustedKeyRequest | WindowsNativeTrustedMouseRequest,
  deliver: (contents: Owner["contents"], viewport: ReturnType<Owner["viewport"]>) => Value
): LegacyWindowsNativeTrustedInputSubmissionBase & Value {
  const deadline = Number(request.deadlineMs);
  const before = owner.probe();
  const viewport = owner.viewport();
  const identity = owner.identity;
  if (!Number.isSafeInteger(deadline) || deadline <= owner.nowMs() ||
      request.roleId !== identity.roleId || request.surfaceGeneration !== identity.surfaceGeneration ||
      before.surfaceHandleToken !== identity.surfaceHandleToken || before.parentHandleToken !== identity.parentHandleToken ||
      !before.currentProcessOwned || !before.exactParent || !before.childWindowStyle ||
      !before.popupWindowStyleAbsent || !before.noActivateStyle ||
      !before.parentWasForeground || !before.parentVisible ||
      before.surfaceVisible !== (request.deliveryMode === "foreground") ||
      (request.deliveryMode === "background" && (before.targetWasForeground || before.targetHadThreadFocus)) ||
      !/^[0-9a-f]{64}$/u.test(before.focusIdentity)) {
    throw new Error("Chromium input owner or deadline is stale before submission.");
  }
  const verify = () => {
    if (owner.nowMs() >= deadline || JSON.stringify(owner.probe()) !== JSON.stringify(before) ||
        JSON.stringify(owner.viewport()) !== JSON.stringify(viewport)) {
      throw new Error("Chromium input ownership, focus or geometry changed during submission.");
    }
  };
  const result = deliver({ sendInputEvent(event) {
    verify();
    owner.contents.sendInputEvent(event);
  } }, viewport);
  verify();
  const submittedAt = owner.nowMs();
  if (submittedAt >= deadline || dispatchSequence >= 18_446_744_073_709_551_615n) {
    throw new Error("Chromium input submission exceeded its owner fence.");
  }
  return Object.freeze({
    ...identity, status: "submitted", submissionApi: "webContents.sendInputEvent",
    requestId: request.requestId, inputEpoch: request.inputEpoch, deliveryMode: request.deliveryMode,
    dispatchSequence: String(++dispatchSequence), probeRevision: owner.probeRevision,
    submittedAtMs: String(submittedAt), withinDeadline: true,
    currentProcessOwned: true, exactParent: true, childWindowStyle: true,
    popupWindowStyleAbsent: true, noActivateStyle: true, targetAttached: true,
    noActivationApiCalled: true, foregroundWindowPreserved: true,
    activeWindowPreserved: true, focusWindowPreserved: true,
    parentWasForeground: true, parentVisible: true, surfaceVisible: before.surfaceVisible,
    targetWasForeground: before.targetWasForeground, targetHadThreadFocus: before.targetHadThreadFocus,
    clientWidth: before.clientWidth, clientHeight: before.clientHeight, dpi: before.dpi,
    ...result
  });
}

export function submitOwnedChromiumKey(owner: Owner, request: WindowsNativeTrustedKeyRequest) {
  return submit(owner, request, contents => sendChromiumKey(contents, request));
}

export function submitOwnedChromiumClick(owner: Owner, request: WindowsNativeTrustedMouseRequest) {
  return submit(owner, request, (contents, viewport) => sendChromiumClick(contents, request, viewport));
}

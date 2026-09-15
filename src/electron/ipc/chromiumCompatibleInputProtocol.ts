import type { CompatibleModifierEvidenceRecord } from "../../shared/generated";

interface CompatibleKeyDescriptor {
  readonly type: "rawKeyDown" | "keyUp";
  readonly code: string;
  readonly key: string;
  readonly shiftedKey?: string;
  readonly modifiers: number;
  readonly location: 0 | 1 | 2;
  readonly windowsVirtualKeyCode: number;
  readonly autoRepeat: boolean;
}

/** Private main-to-isolated-world operation. Never exposed to remote page scripts. */
export interface ChromiumCompatibleInputCommand {
  readonly requestId: string;
  readonly ownerId: string;
  readonly roleId: string;
  readonly inputEpoch: number;
  readonly generation: number;
  readonly frameToken: string;
  readonly documentInstanceId: string;
  readonly sequence: number;
  readonly deadlineMs: number;
  readonly intent: "normal" | "cleanup";
  readonly action: "focus" | "key" | "click";
  readonly key?: CompatibleKeyDescriptor;
  readonly modifierState?: Readonly<{
    coreCodesBefore: readonly string[];
    coreCodesAfter: readonly string[];
    nativePhysicalCodes: readonly string[];
  }>;
  readonly pointer?: Readonly<{
    clientX: number; clientY: number; button: 0 | 1 | 2;
    modifiers: number; releaseOnly: boolean;
  }>;
}

export interface ChromiumCompatibleInputReceipt {
  readonly requestId: string;
  readonly ownerId: string;
  readonly roleId: string;
  readonly inputEpoch: number;
  readonly generation: number;
  readonly frameToken: string;
  readonly documentInstanceId: string;
  readonly sequence: number;
  readonly targetToken: string | null;
  readonly isTrusted: false;
  readonly eventCount: number;
  readonly status: "applied" | "failed" | "indeterminate";
  readonly errorCode: string | null;
  readonly modifierEvidence?: CompatibleModifierEvidenceRecord;
}

export function compatibleInputSource(command: ChromiumCompatibleInputCommand): string {
  return `(() => {
    const command = ${JSON.stringify(command)};
    if (globalThis.__rionStudioDocumentInstanceId !== command.frameToken)
      throw new Error("The compatible input document was superseded.");
    const controller = globalThis.__rionStudioMacroOverlay;
    if (typeof controller?.dispatchCompatibleInput !== "function")
      throw new Error("The compatible game input endpoint is unavailable.");
    return controller.dispatchCompatibleInput(command);
  })()`;
}

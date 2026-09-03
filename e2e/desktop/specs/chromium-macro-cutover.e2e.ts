import {
  restartChromiumMacroTerminalCleanup,
  seedChromiumMacroTerminalCleanup
} from "./chromium-macro-cutover-cleanup";
import { runChromiumMacroInputRecoveryCutover } from
  "./chromium-macro-cutover-input-recovery";
import { runChromiumMacroKeyboardCutover } from "./chromium-macro-cutover-keyboard";
import {
  restartChromiumMacroTopologyCutover,
  seedChromiumMacroTopologyCutover
} from "./chromium-macro-cutover-topology";
import { requiredMacroEnvironment } from "./chromium-macro-cutover-support";

// [journey:CHROMIUM-MACOS-APPKIT-MACRO-INPUT-RECOVERY-011]
// [journey:CHROMIUM-WINDOWS-MACRO-INPUT-RECOVERY-011]
// [journey:CHROMIUM-MACOS-APPKIT-MACRO-MIDDLE-BUTTON-013]
// [journey:CHROMIUM-WINDOWS-MACRO-MIDDLE-BUTTON-013]
// [journey:CHROMIUM-MACOS-APPKIT-MACRO-MODIFIER-CONTINUITY-008]
// [journey:CHROMIUM-WINDOWS-MACRO-MODIFIER-CONTINUITY-008]
// [journey:CHROMIUM-MACOS-APPKIT-MACRO-MULTIROLE-005]
// [journey:CHROMIUM-WINDOWS-MACRO-MULTIROLE-005]
// [journey:CHROMIUM-MACOS-APPKIT-MACRO-OWNERSHIP-TRANSFER-010]
// [journey:CHROMIUM-WINDOWS-MACRO-OWNERSHIP-TRANSFER-010]
// [journey:CHROMIUM-MACOS-APPKIT-MACRO-SHORTCUT-REENTRY-007]
// [journey:CHROMIUM-WINDOWS-MACRO-SHORTCUT-REENTRY-007]
// [journey:CHROMIUM-MACOS-APPKIT-MACRO-TERMINAL-CLEANUP-006]
// [journey:CHROMIUM-WINDOWS-MACRO-TERMINAL-CLEANUP-006]
// [journey:CHROMIUM-MACOS-APPKIT-ROLE-KEY-BLUR-004]
// [journey:CHROMIUM-WINDOWS-ROLE-KEY-BLUR-004]

const phases = Object.freeze({
  "chromium-macro-cutover-input-recovery": runChromiumMacroInputRecoveryCutover,
  "chromium-macro-cutover-keyboard": runChromiumMacroKeyboardCutover,
  "chromium-macro-cutover-terminal-cleanup-restart":
    restartChromiumMacroTerminalCleanup,
  "chromium-macro-cutover-terminal-cleanup-seed": seedChromiumMacroTerminalCleanup,
  "chromium-macro-cutover-topology-restart": restartChromiumMacroTopologyCutover,
  "chromium-macro-cutover-topology-seed": seedChromiumMacroTopologyCutover
} as const);

describe("Chromium Macro paired exact cutover", () => {
  it("runs the exact event-bound Macro cutover phase", async () => {
    const phase = requiredMacroEnvironment("RION_STUDIO_E2E_PHASE");
    const run = phases[phase as keyof typeof phases];
    if (!run) throw new Error(`Unknown Chromium Macro cutover phase ${phase}`);
    await run();
  });
});

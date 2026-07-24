import type {
  CoreCommand,
  CoreCommandResult,
  EmbeddedKeyEffectRecord
} from "../../src/shared/generated";
import type { EmbeddedKeyRuntimeClient } from "../../src/main/core/nativeCore";

type HeldCodes = Map<string, Set<string>>;

export function createEmbeddedKeyRuntimeState(): EmbeddedKeyRuntimeClient {
  const heldByRole = new Map<string, HeldCodes>();
  const pending = new Map<string, { before: HeldCodes; roleId: string }>();
  let sequence = 0;

  const activeCodes = (held: HeldCodes): string[] => [...held]
    .filter(([, owners]) => owners.size > 0)
    .map(([code]) => code)
    .sort();
  const cloneHeld = (held: HeldCodes): HeldCodes => new Map(
    [...held].map(([code, owners]) => [code, new Set(owners)])
  );

  const hold = (
    held: HeldCodes,
    code: string,
    modifierCodes: string[],
    ownerId: string
  ): EmbeddedKeyEffectRecord[] => {
    const effects: EmbeddedKeyEffectRecord[] = [];
    for (const current of [...modifierCodes, code]) {
      const before = activeCodes(held);
      const owners = held.get(current) ?? new Set<string>();
      const wasHeld = owners.size > 0;
      if (owners.has(ownerId)) continue;
      owners.add(ownerId);
      held.set(current, owners);
      if (wasHeld) continue;
      effects.push({
        phase: "rawKeyDown",
        code: current,
        activeCodesBefore: before,
        activeCodes: activeCodes(held),
        autoRepeat: false,
        suppressShortcut: current === code
      });
    }
    return effects;
  };

  const release = (
    held: HeldCodes,
    code: string,
    modifierCodes: string[],
    ownerId: string
  ): EmbeddedKeyEffectRecord[] => {
    const effects: EmbeddedKeyEffectRecord[] = [];
    for (const current of [code, ...modifierCodes.slice().reverse()]) {
      const before = activeCodes(held);
      const owners = held.get(current);
      if (!owners?.delete(ownerId) || owners.size > 0) continue;
      held.delete(current);
      effects.push({
        phase: "keyUp",
        code: current,
        activeCodesBefore: before,
        activeCodes: activeCodes(held),
        autoRepeat: false,
        suppressShortcut: current === code
      });
    }
    return effects;
  };

  return {
    async invoke<C extends CoreCommand>(command: C): Promise<CoreCommandResult<C>> {
      let result: unknown;
      if (command.type === "embeddedKeysClear") {
        heldByRole.delete(command.roleId);
        for (const [id, transition] of pending) {
          if (transition.roleId === command.roleId) pending.delete(id);
        }
        result = null;
      } else if (command.type === "embeddedKeyComplete") {
        const transition = pending.get(command.transitionId);
        if (!transition) throw new Error("Embedded key transition was not found.");
        pending.delete(command.transitionId);
        if (!command.succeeded) {
          if (transition.before.size === 0) heldByRole.delete(transition.roleId);
          else heldByRole.set(transition.roleId, cloneHeld(transition.before));
        }
        result = null;
      } else if (command.type === "embeddedKeysHeld") {
        result = (heldByRole.get(command.roleId)?.size ?? 0) > 0;
      } else if (command.type === "embeddedKeyPrepare") {
        const { roleId, phase, code, modifierCodes, ownerId } = command;
        const held = cloneHeld(heldByRole.get(roleId) ?? new Map());
      const before = cloneHeld(held);
      const effects = phase === "release"
        ? release(held, code, modifierCodes, ownerId)
        : hold(held, code, modifierCodes, phase === "tap" ? `tap:${ownerId}` : ownerId);
      if (phase === "tap") {
        const tapOwner = `tap:${ownerId}`;
        const keyWasHeld = [...(held.get(code) ?? [])].some((owner) => owner !== tapOwner);
        if (keyWasHeld) {
          const existingIndex = effects.findIndex((effect) => effect.code === code);
          if (existingIndex >= 0) effects.splice(existingIndex, 1);
          const active = activeCodes(held);
          effects.push({
            phase: "rawKeyDown",
            code,
            activeCodesBefore: active,
            activeCodes: active,
            autoRepeat: true,
            suppressShortcut: true
          });
        }
        effects.push(...release(held, code, modifierCodes, tapOwner));
      }
      if (held.size === 0) heldByRole.delete(roleId);
      else heldByRole.set(roleId, held);
      const transitionId = `transition-${++sequence}`;
      pending.set(transitionId, { before, roleId });
        result = { transitionId, effects, hasHeldKeys: held.size > 0 };
      } else if (command.type === "embeddedKeysReassert") {
        const held = heldByRole.get(command.roleId) ?? new Map();
        const active = activeCodes(held);
        const effects = [...held.keys()]
          .sort((left, right) =>
            Number(isModifier(right)) - Number(isModifier(left)) || left.localeCompare(right)
          )
          .map((code): EmbeddedKeyEffectRecord => ({
            phase: "rawKeyDown",
            code,
            activeCodesBefore: active,
            activeCodes: active,
            autoRepeat: false,
            suppressShortcut: !isModifier(code)
          }));
        result = { effects, hasHeldKeys: held.size > 0 };
      } else {
        throw new Error(`Unsupported embedded-key test command: ${command.type}`);
      }
      return result as CoreCommandResult<C>;
    }
  };
}

function isModifier(code: string): boolean {
  return /^(Alt|Control|Meta|Shift)(Left|Right)$/.test(code);
}

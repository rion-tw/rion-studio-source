import {
  DEFAULT_LAUNCH_URL,
  type BuiltinGameKey,
  type Game
} from "./types";

export const FLYFF_UNIVERSE_GAME_ID = "builtin-flyff-universe";
export const FEIFEI_INFINITE_UNIVERSE_GAME_ID = "builtin-feifei-infinite-universe";

export interface BuiltinGameDefinition {
  id: string;
  builtinKey: BuiltinGameKey;
  name: string;
  defaultLaunchUrl: string;
}

export const BUILTIN_GAME_DEFINITIONS: readonly BuiltinGameDefinition[] = [
  {
    id: FLYFF_UNIVERSE_GAME_ID,
    builtinKey: "flyff-universe",
    name: "Flyff Universe",
    defaultLaunchUrl: DEFAULT_LAUNCH_URL
  },
  {
    id: FEIFEI_INFINITE_UNIVERSE_GAME_ID,
    builtinKey: "feifei-infinite-universe",
    name: "飞飞：无限宇宙",
    defaultLaunchUrl: "https://ffcli.ruiwoo.cn"
  }
] as const;

export function createBuiltinGame(definition: BuiltinGameDefinition, timestamp: string): Game {
  return {
    ...definition,
    source: "builtin",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function getBuiltinGameDefinition(
  keyOrId: BuiltinGameKey | string
): BuiltinGameDefinition | undefined {
  return BUILTIN_GAME_DEFINITIONS.find(
    (definition) => definition.builtinKey === keyOrId || definition.id === keyOrId
  );
}

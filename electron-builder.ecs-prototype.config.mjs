/** Explicit unpacked experiment only. The ordinary release config keeps the
 * official runtime and its updater signing policy. */
import official from "./electron-builder.config.mjs";
import { ECS_PROTOTYPE_DIST } from "./scripts/ecsPrototypeRuntime.mjs";

export default {
  ...official,
  electronVersion: "44.1.0",
  electronDist: ECS_PROTOTYPE_DIST,
  // EVS signs only the unmodified certified ECS Framework binary. Flipping
  // Electron fuses changes that binary and the service rejects its digest.
  electronFuses: undefined,
  directories: { ...official.directories, output: "release/ecs-prototype" },
  publish: null
};

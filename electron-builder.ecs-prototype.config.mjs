/** Explicit unpacked experiment only. The ordinary release config keeps the
 * official runtime and its updater signing policy. */
import official from "./electron-builder.config.mjs";
import { ECS_PROTOTYPE_DIST } from "./scripts/ecsPrototypeRuntime.mjs";

export default {
  ...official,
  electronVersion: "44.1.0",
  electronDist: ECS_PROTOTYPE_DIST,
  directories: { ...official.directories, output: "release/ecs-prototype" },
  publish: null
};

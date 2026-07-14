import type {
  RoleStatus,
  WorkspaceLaunchInput,
  WorkspaceLaunchResult
} from "../../../../shared/types";

export async function runWorkspaceLaunch({
  launch,
  selectDisplay
}: {
  launch: (input?: WorkspaceLaunchInput) => Promise<WorkspaceLaunchResult>;
  selectDisplay: (
    result: Extract<WorkspaceLaunchResult, { kind: "display_selection_required" }>
  ) => Promise<number | undefined>;
}): Promise<RoleStatus[] | undefined> {
  let result = await launch();
  while (result.kind === "display_selection_required") {
    const displayId = await selectDisplay(result);
    if (displayId === undefined) {
      return undefined;
    }
    result = await launch({ displayId });
  }

  return result.statuses;
}

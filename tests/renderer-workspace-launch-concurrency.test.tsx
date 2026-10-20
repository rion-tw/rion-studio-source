// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { useWorkspaceWorkflow } from "../src/renderer/src/hooks/useWorkspaceWorkflow";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { RionStudioApi } from "../src/shared/api";
import type { LaunchWorkspace } from "../src/shared/types";

const t: Translator = (key) => en[key];

function workspace(id: string): LaunchWorkspace {
  return { id, name: id, slots: [], template: "single" } as unknown as LaunchWorkspace;
}

afterEach(() => vi.restoreAllMocks());

describe("workspace launch concurrency", () => {
  it("launches a second Workspace while the first is still opening", async () => {
    let finishFirst!: () => void;
    const launchWorkspace = vi.fn((id: string) => id === "a"
      ? new Promise((resolve) => { finishFirst = () => resolve({ statuses: [] }); })
      : Promise.resolve({ statuses: [] }));
    window.rionStudio = { launchWorkspace } as unknown as RionStudioApi;
    const wrapper = ({ children }: { children: ReactNode }) => <ConfirmationProvider>{children}</ConfirmationProvider>;
    const { result } = renderHook(() => useWorkspaceWorkflow({
      beginErrorOperation: () => () => undefined, t, workspaces: [workspace("a"), workspace("b")]
    }), { wrapper });

    let first!: Promise<boolean>;
    act(() => { first = result.current.handleLaunchWorkspace(workspace("a")); });
    let second!: boolean;
    await act(async () => { second = await result.current.handleLaunchWorkspace(workspace("b")); });
    expect(second).toBe(true);
    expect(launchWorkspace.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    // The same Workspace still cannot be launched twice at once.
    let repeated!: boolean;
    await act(async () => { repeated = await result.current.handleLaunchWorkspace(workspace("a")); });
    expect(repeated).toBe(false);
    await act(async () => { finishFirst(); await first; });
    expect(launchWorkspace).toHaveBeenCalledTimes(2);
  });
});

import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("main window drag shell", () => {
  it("handles renderer drag and maximize requests on the current Tauri window", async () => {
    const shell = await readFile("src-tauri/src/lib.rs", "utf8");
    const start = shell.indexOf("async fn rion_shell_invoke(");
    const end = shell.indexOf("\nfn string_argument(", start);
    const shellInvoke = shell.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(shellInvoke).toContain('"startCurrentWindowDrag"');
    expect(shellInvoke).toContain(".start_dragging()");
    expect(shellInvoke).toContain('"toggleCurrentWindowMaximize"');
    expect(shellInvoke).toContain(".is_maximized()");
    expect(shellInvoke).toContain(".unmaximize()");
    expect(shellInvoke).toContain(".maximize()");
  });
});

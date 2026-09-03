export function primaryAppWindowHandle(handles: readonly string[]): string {
  const main = handles.find((handle) => handle === "main");
  if (main) return main;
  throw new Error(
    `Desktop E2E main window is unavailable; observed handles: ${JSON.stringify(handles)}`
  );
}

export function electronLauncherWindowHandle(
  windows: ReadonlyArray<Readonly<{ handle: string; url: string }>>
): string {
  const launcher = windows.find(({ url }) => {
    try {
      return new URL(url).pathname.split("/").at(-1) === "index.html";
    } catch {
      return false;
    }
  });
  if (launcher) return launcher.handle;
  throw new Error(
    `Electron desktop E2E launcher window is unavailable; observed windows: ${JSON.stringify(windows)}`
  );
}

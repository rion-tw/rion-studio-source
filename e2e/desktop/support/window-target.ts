export function primaryAppWindowHandle(handles: readonly string[]): string {
  const main = handles.find((handle) => handle === "main");
  if (main) return main;
  throw new Error(
    `Desktop E2E main window is unavailable; observed handles: ${JSON.stringify(handles)}`
  );
}

/** ChromeDriver input to the already selected visible page, with complete key codes. */
export async function sendChromiumEscapeKey(
  driver: Pick<WebdriverIO.Browser, "sendCommandAndGetResult">,
  platform: "macos" | "windows"
): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await driver.sendCommandAndGetResult("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: platform === "windows" ? 27 : 53,
      modifiers: 0,
      autoRepeat: false
    });
  }
}

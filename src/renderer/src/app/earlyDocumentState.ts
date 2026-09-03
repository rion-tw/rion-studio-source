import { windowGestureMode } from "./windowGestureMode";

try {
  const storedTheme = localStorage.getItem("rion-studio-theme");
  const resolvedTheme =
    storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.style.colorScheme = resolvedTheme;
} catch {
  document.documentElement.dataset.theme = "light";
  document.documentElement.style.colorScheme = "light";
}

const platform = navigator.platform.toLowerCase();
const userAgent = navigator.userAgent.toLowerCase();
const resolvedPlatform =
  platform.includes("mac") || userAgent.includes("mac os")
    ? "mac"
    : platform.includes("win") || userAgent.includes("windows")
      ? "windows"
      : "linux";
document.documentElement.dataset.platform = resolvedPlatform;
document.documentElement.dataset.windowGestureMode = windowGestureMode(
  resolvedPlatform,
  __RION_DESKTOP_SHELL__
);
document.documentElement.dataset.windowFullscreen = "false";
document.documentElement.dataset.windowMaximized = "false";
document.documentElement.dataset.windowFocused = "true";
document.documentElement.dataset.windowControlsScrolled = "false";
document.documentElement.dataset.windowsMica = "fallback";

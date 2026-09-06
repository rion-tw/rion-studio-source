/** Read-only hit testing; WebDriver performs the actual user click. */
export function visibleCanvasPoint(): { x: number; y: number } {
  const canvas = document.querySelector("#game-input-canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("The game input canvas is unavailable");
  }
  const bounds = canvas.getBoundingClientRect();
  const left = Math.max(0, bounds.left);
  const top = Math.max(0, bounds.top);
  const right = Math.min(window.innerWidth, bounds.right);
  const bottom = Math.min(window.innerHeight, bounds.bottom);
  if (right > left && bottom > top) {
    for (const vertical of [0.1, 0.9, 0.5]) {
      for (const horizontal of [0.1, 0.9, 0.5]) {
        const x = Math.floor(left + (right - left) * horizontal);
        const y = Math.floor(top + (bottom - top) * vertical);
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
    }
  }
  throw new Error("The game input canvas has no exposed click point");
}

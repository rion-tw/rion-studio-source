import { invoke } from "@tauri-apps/api/core";

const query = new URLSearchParams(location.search);
const axis = query.get("axis") === "horizontal" ? "horizontal" : "vertical";
document.body.dataset.axis = axis;
let dragging = false;
let pending: number | undefined;
let frame: number | undefined;
const pointerCoordinate = (event: PointerEvent): number =>
  axis === "vertical" ? event.screenX : event.screenY;
const send = (phase: "start" | "move" | "end" | "reset", screenPosition?: number): void => {
  void invoke("rion_divider_pointer", {
    payload: { phase, ...(screenPosition === undefined ? {} : { screenPosition }) }
  }).catch(() => undefined);
};
const flush = (): void => {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  if (pending === undefined) return;
  const position = pending;
  pending = undefined;
  send("move", position);
};
addEventListener("pointerdown", (event) => {
  dragging = true;
  document.body.setPointerCapture?.(event.pointerId);
  send("start", pointerCoordinate(event));
  event.preventDefault();
});
addEventListener("pointermove", (event) => {
  if (!dragging) return;
  pending = pointerCoordinate(event);
  if (frame === undefined) frame = requestAnimationFrame(flush);
}, { passive: true });
const finish = (event?: PointerEvent): void => {
  if (!dragging) return;
  if (event) pending = pointerCoordinate(event);
  flush();
  dragging = false;
  send("end");
};
addEventListener("pointerup", (event) => finish(event));
addEventListener("pointercancel", (event) => finish(event));
addEventListener("blur", () => finish());
addEventListener("dblclick", (event) => {
  dragging = false;
  pending = undefined;
  send("reset");
  event.preventDefault();
});

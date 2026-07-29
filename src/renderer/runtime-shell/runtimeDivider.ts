import { invoke } from "@tauri-apps/api/core";

const query = new URLSearchParams(location.search);
const axis = query.get("axis") === "horizontal" ? "horizontal" : "vertical";
document.body.dataset.axis = axis;
let dragging = false;
let pending: number | undefined;
let frame: number | undefined;
let actionPending = false;
type DividerAction = {
  phase: "start" | "move" | "end" | "reset";
  screenPosition?: number;
};
const actionQueue: DividerAction[] = [];
const pointerCoordinate = (event: PointerEvent): number =>
  axis === "vertical" ? event.screenX : event.screenY;
const send = (phase: "start" | "move" | "end" | "reset", screenPosition?: number): void => {
  const action = { phase, ...(screenPosition === undefined ? {} : { screenPosition }) };
  const queued = actionQueue.at(-1);
  if (phase === "move" && queued?.phase === "move") {
    actionQueue[actionQueue.length - 1] = action;
  } else {
    actionQueue.push(action);
  }
  sendNext();
};
const sendNext = (): void => {
  if (actionPending) return;
  const action = actionQueue.shift();
  if (!action) return;
  actionPending = true;
  void invoke("rion_divider_pointer", { payload: action })
    .catch(() => undefined)
    .finally(() => {
      actionPending = false;
      sendNext();
    });
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
  if (dragging || event.button !== 0) return;
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
addEventListener("pointercancel", () => finish());
addEventListener("blur", () => finish());
addEventListener("dblclick", (event) => {
  dragging = false;
  pending = undefined;
  send("reset");
  event.preventDefault();
});

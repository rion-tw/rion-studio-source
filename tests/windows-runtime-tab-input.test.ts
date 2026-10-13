import { EventEmitter } from "node:events";
import type { BaseWindow, Input, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installWindowsRuntimeTabInput } from "../src/electron/main/windowsRuntimeTabInput";

function harness() {
  const app = new EventEmitter();
  const window = Object.assign(new EventEmitter(), { id: 7,
    isFocused: vi.fn(() => true), isDestroyed: vi.fn(() => false) });
  const makeContents = () => Object.assign(new EventEmitter(), {
    isFocused: vi.fn(() => true), isDestroyed: vi.fn(() => false) });
  const first = makeContents();
  const windowFor = vi.fn(() => window as unknown as BaseWindow | null);
  const isRuntimeWindow = vi.fn(() => true);
  const activateAdjacent = vi.fn();
  installWindowsRuntimeTabInput({ app: app as never,
    contents: () => [first as unknown as WebContents], windowFor, isRuntimeWindow, activateAdjacent });
  const create = () => {
    const contents = makeContents();
    app.emit("web-contents-created", {}, contents);
    return contents;
  };
  const emit = (overrides: Partial<Input> = {}, contents = first) => {
    const event = { preventDefault: vi.fn() };
    contents.emit("before-input-event", event, { type: "keyDown", code: "Tab", key: "Tab",
      control: true, shift: false, alt: false, meta: false, isAutoRepeat: false, ...overrides });
    return event.preventDefault;
  };
  return { app, window, first, create, emit, windowFor, isRuntimeWindow, activateAdjacent };
}

describe("Windows main-process tab chord ownership", () => {
  it.each([false, true])("consumes before document/menu dispatch with shift=%s", shift => {
    const h = harness();
    expect(h.emit({ shift })).toHaveBeenCalledOnce();
    expect(h.activateAdjacent).toHaveBeenCalledExactlyOnceWith(shift ? "previous" : "next", h.window);
    expect(h.emit({ type: "keyUp", shift })).toHaveBeenCalledOnce();
    expect(h.activateAdjacent).toHaveBeenCalledOnce();
  });
  it("attaches future Role/loading/chrome contents once and follows keyup to the selected view", () => {
    const h = harness();
    const next = h.create();
    h.app.emit("web-contents-created", {}, next);
    expect(next.listenerCount("before-input-event")).toBe(1);
    h.emit();
    h.first.isFocused.mockReturnValue(false);
    expect(h.emit({ type: "keyUp", control: false }, next)).toHaveBeenCalledOnce();
    expect(h.emit({ type: "keyUp", control: false }, next)).not.toHaveBeenCalled();
    h.emit({ shift: true }, next);
    expect(h.activateAdjacent.mock.calls.map(call => call[0])).toEqual(["next", "previous"]);
  });
  it("consumes repeats even after Control release without scheduling another selection", () => {
    const h = harness();
    h.emit();
    expect(h.emit({ isAutoRepeat: true })).toHaveBeenCalledOnce();
    expect(h.emit({ isAutoRepeat: true, control: false })).toHaveBeenCalledOnce();
    expect(h.activateAdjacent).toHaveBeenCalledOnce();
    expect(h.emit({ type: "keyUp", control: false })).toHaveBeenCalledOnce();
    expect(h.emit({ control: false })).not.toHaveBeenCalled();
  });
  it("consumes a matching release already addressed to the old now-unfocused view", () => {
    const h = harness();
    h.emit();
    h.first.isFocused.mockReturnValue(false);
    expect(h.emit({ type: "keyUp", control: false })).toHaveBeenCalledOnce();
    expect(h.emit({ type: "keyUp" })).not.toHaveBeenCalled();
    expect(h.emit()).not.toHaveBeenCalled();
    expect(h.activateAdjacent).toHaveBeenCalledOnce();
  });
  it("does not initiate selection from an orphan repeated chord", () => {
    const h = harness();
    expect(h.emit({ isAutoRepeat: true })).toHaveBeenCalledOnce();
    expect(h.activateAdjacent).not.toHaveBeenCalled();
  });
  it.each(["blur", "closed", "ordinary-tab"])("ends consumption ownership on %s", terminal => {
    const h = harness();
    h.emit();
    if (terminal === "ordinary-tab") expect(h.emit({ control: false })).not.toHaveBeenCalled();
    else h.window.emit(terminal);
    expect(h.emit({ type: "keyUp", control: false })).not.toHaveBeenCalled();
    expect(h.window.listenerCount("blur")).toBe(1);
  });
  it.each(["unfocused-content", "destroyed-content", "unfocused-host", "destroyed-host", "unmanaged-host", "no-host"])(
    "ignores %s without consuming its document keys", state => {
      const h = harness();
      if (state === "unfocused-content") h.first.isFocused.mockReturnValue(false);
      if (state === "destroyed-content") h.first.isDestroyed.mockReturnValue(true);
      if (state === "unfocused-host") h.window.isFocused.mockReturnValue(false);
      if (state === "destroyed-host") h.window.isDestroyed.mockReturnValue(true);
      if (state === "unmanaged-host") h.isRuntimeWindow.mockReturnValue(false);
      if (state === "no-host") h.windowFor.mockReturnValue(null);
      expect(h.emit()).not.toHaveBeenCalled();
      expect(h.activateAdjacent).not.toHaveBeenCalled();
    }
  );
  it.each([{ control: false }, { alt: true }, { meta: true }, { code: "F11" }, { type: "char" }])(
    "preserves unrelated input %j", key => {
      const h = harness();
      expect(h.emit(key)).not.toHaveBeenCalled();
      expect(h.activateAdjacent).not.toHaveBeenCalled();
    }
  );
  it("does not consume an ordinary keyup in a different native host", () => {
    const h = harness();
    h.emit();
    const other = Object.assign(new EventEmitter(), { id: 8,
      isFocused: () => true, isDestroyed: () => false });
    h.windowFor.mockReturnValue(other as unknown as BaseWindow);
    expect(h.emit({ type: "keyUp", control: false }, h.create())).not.toHaveBeenCalled();
  });
});

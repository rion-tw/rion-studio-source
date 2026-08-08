import { describe, expect, it } from "vitest";

import {
  parseMacroCommand,
  type MacroCommandIssueCode
} from "../src/renderer/src/features/macros/macroCommandParser";
import { MACRO_DELAY_MAX_MS } from "../src/shared/macroSettings";
import type { Macro } from "../src/shared/types";

describe("parseMacroCommand", () => {
  it("parses the FlyffHelper click and wait sequence in order", () => {
    const result = parseMacroCommand(
      "v>wait:600>click:79px,100px>wait:600>click:213px,723px>wait:600>click:318px,926px>wait:600>click:717px,73px>wait:400>click:717px,73px>wait:400>click:717px,73px>wait:600>click:512px,927px>wait:600>click:717px,73px>wait:400>click:717px,73px>wait:600>click:684px,926px>wait:600>click:717px,73px>wait:400>click:717px,73px>wait:400>click:717px,73px>wait:600>v",
      { idFactory: createIdFactory() }
    );

    expect(result.issues).toEqual([]);
    expect(result.steps[0]).toMatchObject({ type: "key", code: "KeyV", action: "tap" });
    expect(result.steps.at(-1)).toMatchObject({ type: "key", code: "KeyV", action: "tap" });
    expect(result.steps.filter((step) => step.type === "click")).toHaveLength(13);
    expect(result.steps.filter((step) => step.type === "delay")).toHaveLength(14);
    expect(result.steps.filter((step) => step.type === "key")).toHaveLength(2);
    expect(result.steps.find((step) =>
      step.type === "click" &&
      step.unit === "reference-px" &&
      step.xReferencePx === 79
    )).toMatchObject({
      type: "click",
      unit: "reference-px",
      xReferencePx: 79,
      yReferencePx: 100
    });
  });

  it("accepts case-insensitive commands, percent coordinates, aliases, and quoted separators", () => {
    const result = parseMacroCommand(
      ' V > WAIT:42 > CLICK:50%, 25% > ENTER > say:"hello>world"',
      { idFactory: createIdFactory() }
    );

    expect(result.steps).toMatchObject([
      { type: "key", code: "KeyV" },
      { type: "delay", ms: 42 },
      { type: "click", xPercent: 50, yPercent: 25 },
      { type: "key", code: "Enter" }
    ]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["unsupported"]);
    expect(result.issues[0]?.token).toBe("say:hello>world");
  });

  it("accepts KeyboardEvent code names in addition to shorthand keys", () => {
    const result = parseMacroCommand(
      "keya>digit1>backquote>insert>home>delete>end>equal>minus>backslash>slash>period>comma>semicolon>quote>bracketleft>bracketright>f24>meta",
      { idFactory: createIdFactory() }
    );

    expect(result.issues).toEqual([]);
    expect(result.steps.map((step) => step.type === "key" ? step.code : "")).toEqual([
      "KeyA",
      "Digit1",
      "Backquote",
      "Insert",
      "Home",
      "Delete",
      "End",
      "Equal",
      "Minus",
      "Backslash",
      "Slash",
      "Period",
      "Comma",
      "Semicolon",
      "Quote",
      "BracketLeft",
      "BracketRight",
      "F24",
      "MetaLeft"
    ]);
  });

  it("imports the full Ctrl-number and Alt-number sequence as key combinations", () => {
    const result = parseMacroCommand(
      "ctrl+1>wait:600>ctrl+2>wait:600>ctrl+3>wait:600>ctrl+4>wait:600>ctrl+5>wait:600>ctrl+6>wait:600>ctrl+7>wait:600>ctrl+8>wait:600>ctrl+9>wait:600>ctrl+0>wait:600>alt+1",
      { idFactory: createIdFactory() }
    );
    const keySteps = result.steps.filter((step) => step.type === "key");

    expect(result.issues).toEqual([]);
    expect(result.steps).toHaveLength(21);
    expect(result.steps.filter((step) => step.type === "delay")).toHaveLength(10);
    expect(keySteps.map((step) => ({ code: step.code, modifiers: step.modifiers }))).toEqual([
      ...Array.from({ length: 9 }, (_, index) => ({
        code: `Digit${index + 1}`,
        modifiers: ["ctrl"]
      })),
      { code: "Digit0", modifiers: ["ctrl"] },
      { code: "Digit1", modifiers: ["alt"] }
    ]);
  });

  it("accepts modifier aliases, flexible prefix order, case, and whitespace", () => {
    const result = parseMacroCommand(
      " Shift + CTRL + Alt + 1 > primary+tab > cmd+enter > Command+F1 > META+digit2 > win+a > Windows+KeyB > control+delete ",
      { idFactory: createIdFactory() }
    );
    const keySteps = result.steps.filter((step) => step.type === "key");

    expect(result.issues).toEqual([]);
    expect(keySteps.map((step) => ({ code: step.code, modifiers: step.modifiers }))).toEqual([
      { code: "Digit1", modifiers: ["ctrl", "alt", "shift"] },
      { code: "Tab", modifiers: ["primary"] },
      { code: "Enter", modifiers: ["meta"] },
      { code: "F1", modifiers: ["meta"] },
      { code: "Digit2", modifiers: ["meta"] },
      { code: "KeyA", modifiers: ["meta"] },
      { code: "KeyB", modifiers: ["meta"] },
      { code: "Delete", modifiers: ["ctrl"] }
    ]);
  });

  it("rejects malformed combinations while preserving adjacent valid steps", () => {
    const invalidCombinations = [
      "crtl+1",
      "ctrl+",
      "1+ctrl",
      "ctrl+a+b",
      "ctrl+alt",
      "ctrl+ctrl+1",
      "ctrl+control+1",
      "primary+ctrl+a",
      "primary+meta+a",
      "+",
      "ctrl++1"
    ];
    const result = parseMacroCommand(
      `${invalidCombinations.join(">")}>wait:25>A>ctrl>alt`,
      { idFactory: createIdFactory() }
    );

    expect(result.issues.map((issue) => issue.code)).toEqual(
      invalidCombinations.map(() => "invalidKeyCombination")
    );
    expect(result.steps).toMatchObject([
      { type: "delay", ms: 25 },
      { type: "key", code: "KeyA", action: "tap" },
      { type: "key", code: "ControlLeft", action: "tap" },
      { type: "key", code: "AltLeft", action: "tap" }
    ]);
  });

  it("maps call and start for held targets to existing macro steps", () => {
    const macros = [createMacro("once", "Once", { type: "once" }, true), createMacro("loop", "Loop", {
      type: "loop",
      intervalMs: 500
    }, true)];
    const result = parseMacroCommand("call:Once>call:Loop>start:Loop", {
      idFactory: createIdFactory(),
      macros
    });

    expect(result.steps).toMatchObject([
      { type: "macro", macroId: "once", callMode: "wait" },
      { type: "macro", macroId: "loop", callMode: "trigger" },
      { type: "macro", macroId: "loop", callMode: "trigger" }
    ]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["callToggle", "callToggle"]);
  });

  it("reports every FlyffHelper-only command as unsupported", () => {
    const commands = [
      "say:hello",
      "autoatkit",
      "autoatk:20,30",
      "atkaround",
      "atkfront",
      "autoberry",
      "lookforward",
      "stop",
      "send:macro,run"
    ];
    const result = parseMacroCommand(commands.join(">"), { idFactory: createIdFactory() });

    expect(result.steps).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(commands.map(() => "unsupported"));
  });

  it("reports unsupported commands and malformed tokens while preserving valid steps", () => {
    const result = parseMacroCommand(
      `A>say:"hello">autoatk:20,30>stop:Loop>send:target,cmd>wait:no>wait:${MACRO_DELAY_MAX_MS + 1}>click:10.5px,20px>click:10px,20%>wat:1>???`,
      { idFactory: createIdFactory() }
    );

    expect(result.steps).toMatchObject([{ type: "key", code: "KeyA" }]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
      "invalidWait",
      "invalidWait",
      "invalidClick",
      "invalidClick",
      "unknownCommand",
      "unknownKey"
    ] satisfies MacroCommandIssueCode[]);
  });

  it("reports missing and unavailable macro targets", () => {
    const macros = [createMacro("current", "Current", { type: "once" })];
    const result = parseMacroCommand("call:Missing>start:Current", {
      currentMacroId: "current",
      idFactory: createIdFactory(),
      macros
    });

    expect(result.steps).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["missingMacro", "unavailableMacro"]);
  });

  it("reports unmatched quotes and the combined step limit", () => {
    const result = parseMacroCommand('A>B>say:"unfinished', {
      idFactory: createIdFactory(),
      maxSteps: 1
    });

    expect(result.steps).toHaveLength(2);
    expect(result.issues.map((issue) => issue.code)).toEqual(["unclosedQuote", "unsupported", "stepLimit"]);
    expect(result.issues.at(-1)).toMatchObject({ code: "stepLimit", detail: "1" });
  });
});

function createIdFactory(): () => string {
  let nextId = 1;
  return () => `step-${nextId++}`;
}

function createMacro(
  id: string,
  name: string,
  repeat: Macro["repeat"],
  holdsKey = false
): Macro {
  return {
    id,
    enabled: true,
    name,
    roleIds: ["role-1"],
    shortcutSourceScope: { type: "all_execution_roles" as const },
    repeat,
    steps: holdsKey
      ? [{ id: `${id}-hold`, type: "key", code: "KeyW", action: "hold_until_stop" }]
      : [{ id: `${id}-key`, type: "key", code: "KeyW" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

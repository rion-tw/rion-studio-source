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
    expect(result.steps.find((step) => step.type === "click" && step.unit === "px" && step.xPx === 79)).toMatchObject({
      type: "click",
      unit: "px",
      xPx: 79,
      yPx: 100
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

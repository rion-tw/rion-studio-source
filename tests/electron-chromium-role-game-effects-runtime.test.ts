import { afterEach, describe, expect, it, vi } from "vitest";

import { installChromiumRoleGameEffectsRuntime } from
  "../src/electron/preload/chromiumRoleGameEffectsRuntime";

const BLEND = 0x0be2, DEPTH_TEST = 0x0b71, FRAGMENT_SHADER = 0x8b30, VERTEX_SHADER = 0x8b31;
const ONE = 1, SRC_ALPHA = 0x302, ONE_MINUS_SRC_ALPHA = 0x303, ONE_MINUS_DST_COLOR = 0x307;
const FUNC_ADD = 0x8006, FUNC_REVERSE_SUBTRACT = 0x800b, TRIANGLES = 4, TRIANGLE_FAN = 6;
const TEXTURE_2D = 0x0de1, TEXTURE0 = 0x84c0;

type Call = { name: string; args: unknown[] };

/** Texture packs the fake game downloads, keyed by pack name. */
const packs = new Map<string, Uint8Array<ArrayBuffer>>();

function textureBytes(seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4096);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + seed * 17 + (index >> 3)) & 0xff;
  return bytes;
}

/** Downloads a pack, uploads one of its textures and binds it to unit 0. */
async function identifiedTexture(
  gl: Record<string, (...args: unknown[]) => unknown>,
  pack: string,
  seed: number
) {
  const bytes = textureBytes(seed);
  packs.set(pack, bytes);
  await fetch(`https://universe.flyff.com/client/model/texturelow/dxt/${pack}.bin`);
  await new Promise(resolve => setTimeout(resolve, 0));
  const texture = { texture: pack };
  gl.activeTexture!(TEXTURE0);
  gl.bindTexture!(TEXTURE_2D, texture);
  gl.compressedTexImage2D!(TEXTURE_2D, 0, 0, 64, 64, 0, bytes);
  return texture;
}

function effectState(gl: Record<string, (...args: unknown[]) => unknown>) {
  linkedProgram(gl);
  gl.enable!(BLEND);
  gl.enable!(DEPTH_TEST);
  gl.blendEquation!(FUNC_ADD);
  gl.blendFunc!(SRC_ALPHA, ONE);
}

function draws(calls: Call[]) {
  return calls.filter(call => call.name === "drawArrays" || call.name === "drawElements").length;
}

/** A recording WebGL prototype with the constants the runtime reads. */
function installFakeWebGl() {
  const calls: Call[] = [];
  const record = (name: string) => function (...args: unknown[]) {
    calls.push({ name, args });
    if (name === "createShader") return { shader: args[0] };
    if (name === "getUniformLocation") return { uniform: args[1] };
    return undefined;
  };
  class FakeWebGLRenderingContext {}
  const prototype = FakeWebGLRenderingContext.prototype as unknown as Record<string, unknown>;
  Object.assign(prototype, {
    BLEND, DEPTH_TEST, FRAGMENT_SHADER, VERTEX_SHADER, TEXTURE_2D, TEXTURE0
  });
  for (const name of [
    "createShader", "shaderSource", "linkProgram", "useProgram", "enable", "disable",
    "blendFunc", "blendFuncSeparate", "blendEquation", "blendEquationSeparate",
    "activeTexture", "bindTexture", "compressedTexImage2D", "texImage2D", "depthMask",
    "drawElements", "drawArrays", "uniform3f", "getUniformLocation"
  ]) prototype[name] = record(name);
  vi.stubGlobal("WebGLRenderingContext", FakeWebGLRenderingContext);
  vi.stubGlobal("WebGL2RenderingContext", undefined);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve(new Response(packs.get(/(\w+)\.bin$/u.exec(url)?.[1] ?? "") ?? "x"))));
  return { calls, gl: new FakeWebGLRenderingContext() as unknown as Record<string, (...args: unknown[]) => unknown> };
}

function linkedProgram(gl: Record<string, (...args: unknown[]) => unknown>) {
  const shader = gl.createShader!(FRAGMENT_SHADER);
  gl.shaderSource!(shader, "precision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }");
  const program = { program: true };
  gl.linkProgram!(program);
  gl.useProgram!(program);
  return program;
}

function uniforms(calls: Call[]) {
  return calls.filter(call => call.name === "uniform3f").map(call => call.args.slice(1));
}

afterEach(() => {
  vi.unstubAllGlobals();
  packs.clear();
});

describe("Chromium role game-effects runtime", () => {
  it("is self-contained so contextBridge can serialize it into the main world", () => {
    const { gl } = installFakeWebGl();
    const serialized = new Function(`return (${installChromiumRoleGameEffectsRuntime.toString()});`)() as
      typeof installChromiumRoleGameEffectsRuntime;
    const set = serialized({ brightness: 0.25, dimBrightSkills: true, hideHitEffects: false });
    expect(typeof set).toBe("function");
    expect(gl.drawArrays).not.toBe(undefined);
  });

  it("wraps fragment shaders with an identity-by-default coefficient", () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 1, dimBrightSkills: false, hideHitEffects: false });
    const fragment = gl.createShader!(FRAGMENT_SHADER);
    const vertex = gl.createShader!(VERTEX_SHADER);
    gl.shaderSource!(fragment, "void main() { gl_FragColor = vec4(1.0); }");
    gl.shaderSource!(vertex, "void main() { gl_Position = vec4(0.0); }");
    const [patched, untouched] = calls.filter(call => call.name === "shaderSource").map(call => call.args[1]);
    expect(patched).toContain("void fms_main(");
    expect(patched).toContain("uniform mediump vec3 fmsFx;");
    expect(untouched).toBe("void main() { gl_Position = vec4(0.0); }");
  });

  it("screen-blends a dimmed additive effect and restores the game's blend state", () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 0.25, dimBrightSkills: false, hideHitEffects: false });
    linkedProgram(gl);
    gl.enable!(BLEND);
    gl.enable!(DEPTH_TEST);
    gl.blendEquation!(FUNC_ADD);
    gl.blendFunc!(SRC_ALPHA, ONE);
    gl.drawArrays!(TRIANGLE_FAN, 0, 4);
    expect(uniforms(calls).at(-1)).toEqual([1, 0.75, 1]);
    const blends = calls.filter(call => call.name === "blendFuncSeparate").map(call => call.args);
    expect(blends).toEqual([[ONE_MINUS_DST_COLOR, ONE, 0, ONE], [SRC_ALPHA, ONE, SRC_ALPHA, ONE]]);
  });

  it("leaves sky, water and UI draws of non-effect programs untouched", () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 0, dimBrightSkills: true, hideHitEffects: true });
    linkedProgram(gl);
    gl.enable!(BLEND);
    gl.blendEquation!(FUNC_ADD);
    gl.blendFunc!(SRC_ALPHA, ONE_MINUS_SRC_ALPHA);
    gl.depthMask!(false);
    gl.drawElements!(TRIANGLES, 6, 0, 0);
    // Never drew additive with depth testing: not an effect program.
    expect(uniforms(calls)).toEqual([[0, 0, 0]]);
    gl.blendEquation!(FUNC_REVERSE_SUBTRACT);
    gl.drawElements!(TRIANGLES, 6, 0, 0);
    expect(uniforms(calls)).toEqual([[0, 0, 0]]);
    expect(calls.some(call => call.name === "blendFuncSeparate")).toBe(false);
  });

  it("applies live level changes and becomes a pass-through at brightness 1", () => {
    const { calls, gl } = installFakeWebGl();
    const set = installChromiumRoleGameEffectsRuntime({ brightness: 0.08, dimBrightSkills: false, hideHitEffects: false });
    linkedProgram(gl);
    gl.enable!(BLEND);
    gl.enable!(DEPTH_TEST);
    gl.blendFunc!(ONE, ONE);
    gl.drawArrays!(TRIANGLE_FAN, 0, 4);
    expect(uniforms(calls).at(-1)).toEqual([0, Math.round(0.92 * 4096) / 4096, 1]);
    set(1, false, false);
    gl.drawArrays!(TRIANGLE_FAN, 0, 4);
    expect(uniforms(calls).at(-1)).toEqual([0, 0, 0]);
  });

  it("forwards the game's GL call even when bookkeeping throws", () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 0.25, dimBrightSkills: true, hideHitEffects: false });
    const hostile = { get buffer(): never { throw new Error("detached"); }, byteLength: 4096, byteOffset: 0 };
    expect(() => gl.compressedTexImage2D!(TEXTURE_2D, 0, 0, 4, 4, 0, hostile)).not.toThrow();
    expect(calls.some(call => call.name === "compressedTexImage2D")).toBe(true);
  });

  it("installs once per document", () => {
    const { gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 0.25, dimBrightSkills: true, hideHitEffects: false });
    const wrapped = gl.drawArrays;
    installChromiumRoleGameEffectsRuntime({ brightness: 0.25, dimBrightSkills: true, hideHitEffects: false });
    expect(gl.drawArrays).toBe(wrapped);
  });

  it("skips draws whose coefficient cancels them completely", () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 0, dimBrightSkills: false, hideHitEffects: false });
    effectState(gl);
    gl.drawArrays!(TRIANGLE_FAN, 0, 4);
    expect(draws(calls)).toBe(0);
    gl.blendEquation!(FUNC_REVERSE_SUBTRACT);
    gl.blendFunc!(SRC_ALPHA, ONE_MINUS_SRC_ALPHA);
    gl.depthMask!(false);
    gl.drawArrays!(TRIANGLE_FAN, 0, 4);
    expect(draws(calls)).toBe(0);
    expect(uniforms(calls)).toEqual([]);
  });

  it("always draws Boss ground warnings untouched", async () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 0, dimBrightSkills: true, hideHitEffects: true });
    await identifiedTexture(gl, "sfx_attackcast", 1);
    effectState(gl);
    gl.drawArrays!(TRIANGLE_FAN, 0, 4);
    expect(draws(calls)).toBe(1);
    expect(uniforms(calls)).toEqual([[0, 0, 0]]);
  });

  it("identifies earlier uploads at unaligned offsets once their pack arrives", async () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 0, dimBrightSkills: true, hideHitEffects: false });
    const first = textureBytes(3), second = textureBytes(4);
    // Flat padding stands in for the repeated regions that once made matching quadratic.
    const pack = new Uint8Array(40_000).fill(0x11);
    pack.set(first, 1_003);
    pack.set(second, 20_002);
    const textures = [first, second].map((bytes, index) => {
      const texture = { texture: index };
      gl.bindTexture!(TEXTURE_2D, texture);
      gl.compressedTexImage2D!(TEXTURE_2D, 0, 0, 64, 64, 0, bytes);
      return texture;
    });
    packs.set("sfx_attackcast", pack);
    await fetch("https://universe.flyff.com/client/model/texturemid/dxt/sfx_attackcast.bin");
    await fetch("https://universe.flyff.com/client/model/texturemid/dxt/sfx_attackcast.bin?again");
    await new Promise(resolve => setTimeout(resolve, 0));
    effectState(gl);
    for (const texture of textures) {
      gl.bindTexture!(TEXTURE_2D, texture);
      gl.drawArrays!(TRIANGLE_FAN, 0, 4);
    }
    // Boss warnings draw untouched even at the Hidden level.
    expect(draws(calls)).toBe(2);
    expect(uniforms(calls)).toEqual([[0, 0, 0]]);
  });

  it("caps stacked particle copies per frame and divides by the capped count", async () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 0.7, dimBrightSkills: true, hideHitEffects: false });
    await identifiedTexture(gl, "sfx_sklpsypsychicbomb", 2);
    effectState(gl);
    const POINTS = 0;
    for (let copy = 0; copy < 60; copy++) gl.drawArrays!(POINTS, 0, 1);
    expect(draws(calls)).toBe(48);
    const reduceFor = (copies: number) => Math.round((1 - 0.7 * 0.3 / copies) * 4096) / 4096;
    const applied = uniforms(calls).map(values => values[1]);
    expect(applied[0]).toBe(reduceFor(1));
    expect(applied.at(-1)).toBe(reduceFor(48));
  });

  it("thins repeated particle clouds to a stable prefix and brightens the survivors", () => {
    const { calls, gl } = installFakeWebGl();
    let frame = () => undefined as unknown;
    vi.stubGlobal("requestAnimationFrame", (callback: () => unknown) => { frame = callback; return 0; });
    installChromiumRoleGameEffectsRuntime({ brightness: 1, dimBrightSkills: false, hideHitEffects: false, density: 0.5 });
    effectState(gl);
    const cloud = { texture: "cloud" }, single = { texture: "single" };
    const drawFrame = () => {
      calls.length = 0;
      gl.bindTexture!(TEXTURE_2D, single);
      gl.drawArrays!(TRIANGLE_FAN, 0, 4);
      gl.bindTexture!(TEXTURE_2D, cloud);
      for (let copy = 0; copy < 40; copy++) gl.drawArrays!(TRIANGLE_FAN, 0, 4);
      frame();
    };
    // A newly appearing cloud draws in full; later frames keep half of it.
    drawFrame();
    expect(draws(calls)).toBe(41);
    for (let index = 0; index < 12; index++) drawFrame();
    expect(draws(calls)).toBe(21);
    // Survivors double their light; undimmed effects keep the game's blending.
    const [alphaOnly, reduce, screen] = uniforms(calls).at(-1) as number[];
    expect([alphaOnly, screen]).toEqual([1, 0]);
    expect(reduce).toBeCloseTo(-1, 2);
    expect(calls.some(call => call.name === "blendFuncSeparate")).toBe(false);
  });

  it("never thins Boss ground warnings", async () => {
    const { calls, gl } = installFakeWebGl();
    let frame = () => undefined as unknown;
    vi.stubGlobal("requestAnimationFrame", (callback: () => unknown) => { frame = callback; return 0; });
    installChromiumRoleGameEffectsRuntime({ brightness: 1, dimBrightSkills: false, hideHitEffects: false, density: 0.25 });
    await identifiedTexture(gl, "sfx_attackcast", 5);
    effectState(gl);
    for (let index = 0; index < 5; index++) {
      calls.length = 0;
      for (let copy = 0; copy < 30; copy++) gl.drawArrays!(TRIANGLE_FAN, 0, 4);
      frame();
    }
    expect(draws(calls)).toBe(30);
    expect(uniforms(calls)).toEqual([]);
  });

  it("keeps a pass-through page free of classification and uniform writes", () => {
    const { calls, gl } = installFakeWebGl();
    installChromiumRoleGameEffectsRuntime({ brightness: 1, dimBrightSkills: false, hideHitEffects: false });
    effectState(gl);
    for (let copy = 0; copy < 5; copy++) gl.drawArrays!(TRIANGLES, 0, 3);
    expect(draws(calls)).toBe(5);
    expect(uniforms(calls)).toEqual([]);
  });
});

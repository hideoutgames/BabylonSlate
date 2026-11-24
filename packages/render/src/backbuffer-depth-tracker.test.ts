import { describe, expect, it } from "vitest";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { BackbufferDepthTracker } from "./backbuffer-depth-tracker";

/**
 * An Engine as the tracker reads it: Babylon's state caches, the draw counter and the bound framebuffer, with a `clear`
 * that records what reached it (`c` colour, `d` depth, `s` stencil) and draws that count.
 */
function engine() {
  const reached: string[] = [];
  const stencilGlobal = { enabled: false };
  const fake = {
    _currentFramebuffer: null as unknown,
    _drawCalls: { current: 0 },
    frameId: 0,
    width: 640,
    getRenderWidth() { return fake.width; },
    getRenderHeight() { return 360; },
    useReverseDepthBuffer: false,
    depthCullingState: { depthTest: true, depthMask: true },
    stencilState: { stencilMask: 0xff },
    stencilStateComposer: { useStencilGlobalOnly: false, stencilMaterial: null as { enabled: boolean } | null, stencilGlobal },
    clear(color: unknown, backBuffer: boolean, depth: boolean, stencil = false) {
      reached.push(`${color && backBuffer ? "c" : ""}${depth ? "d" : ""}${stencil ? "s" : ""}`);
    },
    /** A clear left out whole makes no clear call: it binds a deferred attachments restore and applies the states (`-`). */
    _pendingAttachments: null as unknown,
    _flushAttachments() { reached.push("attachments"); },
    applyStates() {
      // As a clear applies them: the stencil from its global state.
      reached.push(fake.stencilStateComposer.useStencilGlobalOnly ? "-" : "material stencil");
    },
    enableScissor() {},
    disableScissor() {},
    drawElementsType: (() => { fake._drawCalls.current += 1; }) as (fillMode: number, start: number, count: number, instances?: number) => void,
    drawArraysType: (() => { fake._drawCalls.current += 1; }) as (fillMode: number, start: number, count: number, instances?: number) => void,
  };
  const original = { drawElements: fake.drawElementsType, drawArrays: fake.drawArraysType };
  const tracker = new BackbufferDepthTracker(fake as unknown as AbstractEngine);
  const babylon = fake as unknown as AbstractEngine;
  const draw = () => babylon.drawElementsType(0, 0, 3);
  /** A layer's depth-stencil clear inside a layer pass. */
  const layerClear = () => babylon.clear(null as never, false, true, true);
  const worldClear = () => babylon.clear({} as never, true, true, true);
  return { fake, babylon, tracker, reached, draw, layerClear, worldClear, original, stencilGlobal };
}

describe("the backbuffer depth tracker", () => {
  it("leaves out a layer pass's depth-stencil clear only while the backbuffer holds what that clear writes", () => {
    const { tracker, reached, layerClear } = engine();
    // Nothing known yet: the clear runs.
    tracker.beginLayerPass();
    layerClear();
    layerClear();
    tracker.endLayerPass();
    expect(reached).toEqual(["ds", "-"]);
    expect({ depthClears: tracker.depthClears, elided: tracker.elided }).toEqual({ depthClears: 1, elided: 1 });
    // Outside a layer pass every clear runs.
    layerClear();
    layerClear();
    expect(reached).toEqual(["ds", "-", "ds", "ds"]);
  });

  it("leaves a clear with nothing left to clear out of the context, binding pending attachments and applying the states as the clear would", () => {
    const { fake, babylon, tracker, reached, layerClear } = engine();
    tracker.beginLayerPass();
    layerClear();
    fake._pendingAttachments = [0];
    fake.stencilStateComposer.useStencilGlobalOnly = false;
    layerClear();
    // A layer clear with its colour keeps the colour: only depth and stencil are left out.
    babylon.clear({} as never, true, true, true);
    tracker.endLayerPass();
    expect(reached).toEqual(["ds", "attachments", "-", "c"]);
    expect(fake.stencilStateComposer.useStencilGlobalOnly).toBe(false);
    expect({ clears: tracker.clears, depthClears: tracker.depthClears, elided: tracker.elided }).toEqual({ clears: 2, depthClears: 1, elided: 2 });
  });

  it("keeps the world clear's colour, and leaves the first layer's clear out after the world's merged clear and its one draw", () => {
    const { tracker, reached, draw, layerClear, worldClear } = engine();
    worldClear();
    tracker.noteFoldedClear();
    draw();
    tracker.beginLayerPass();
    layerClear();
    tracker.endLayerPass();
    expect(reached).toEqual(["cds", "-"]);
    // A second draw before the layers is not the output pass's: the clear runs.
    worldClear();
    tracker.noteFoldedClear();
    draw();
    draw();
    tracker.beginLayerPass();
    layerClear();
    tracker.endLayerPass();
    expect(reached.slice(2)).toEqual(["cds", "ds"]);
    // A loading frame's clear allows no draw at all.
    worldClear();
    draw();
    tracker.beginLayerPass();
    layerClear();
    tracker.endLayerPass();
    expect(reached.slice(4)).toEqual(["cds", "ds"]);
  });

  it("forgets a world clear at another Engine frame or another backbuffer size", () => {
    const { fake, tracker, reached, layerClear, worldClear } = engine();
    for (const change of [() => { fake.frameId += 1; }, () => { fake.width += 16; }]) {
      worldClear();
      change();
      tracker.beginLayerPass();
      layerClear();
      tracker.endLayerPass();
    }
    expect(reached).toEqual(["cds", "ds", "cds", "ds"]);
  });

  it("clears again after a layer draw that writes depth or may write stencil, not after one that only reads depth", () => {
    const { fake, tracker, reached, draw, layerClear, stencilGlobal } = engine();
    tracker.beginLayerPass();
    layerClear();
    fake.depthCullingState.depthMask = false;
    draw();
    layerClear();
    expect(reached).toEqual(["ds", "-"]);
    fake.depthCullingState.depthMask = true;
    draw();
    layerClear();
    expect(reached).toEqual(["ds", "-", "ds"]);
    // Without the depth test a draw writes no depth.
    fake.depthCullingState.depthTest = false;
    draw();
    layerClear();
    expect(reached).toHaveLength(4);
    expect(reached[3]).toBe("-");
    stencilGlobal.enabled = true;
    draw();
    layerClear();
    expect(reached[4]).toBe("ds");
    stencilGlobal.enabled = false;
    fake.stencilStateComposer.stencilMaterial = { enabled: true };
    draw();
    layerClear();
    expect(reached[5]).toBe("ds");
    tracker.endLayerPass();
  });

  it("counts the buffers cleared only after a clear of both that reached every pixel and bit", () => {
    for (const partial of [
      (setup: ReturnType<typeof engine>) => setup.babylon.enableScissor(0, 0, 1, 1),
      (setup: ReturnType<typeof engine>) => { setup.fake.depthCullingState.depthMask = false; },
      (setup: ReturnType<typeof engine>) => { setup.fake.stencilState.stencilMask = 0x0f; },
    ]) {
      const setup = engine();
      partial(setup);
      setup.tracker.beginLayerPass();
      setup.layerClear();
      setup.layerClear();
      setup.tracker.endLayerPass();
      expect(setup.reached).toEqual(["ds", "ds"]);
    }
    // The scissor off again: whole.
    const setup = engine();
    setup.babylon.enableScissor(0, 0, 1, 1);
    setup.babylon.disableScissor();
    setup.tracker.beginLayerPass();
    setup.layerClear();
    setup.layerClear();
    // Depth alone leaves the stencil unknown; a clear to another stencil value is not the one held.
    setup.babylon.clear(null as never, false, true, false);
    setup.babylon.clear(null as never, false, true, true, 1);
    setup.tracker.endLayerPass();
    expect(setup.reached).toEqual(["ds", "-", "-", "ds"]);
  });

  it("follows only the default framebuffer, and forgets at the end of each layer pass", () => {
    const { fake, tracker, reached, draw, layerClear } = engine();
    tracker.beginLayerPass();
    layerClear();
    // Another target's draws and clears change nothing of the backbuffer's, and its clears always run.
    fake._currentFramebuffer = {};
    draw();
    layerClear();
    fake._currentFramebuffer = null;
    layerClear();
    expect(reached).toEqual(["ds", "ds", "-"]);
    tracker.endLayerPass();
    tracker.beginLayerPass();
    layerClear();
    tracker.endLayerPass();
    expect(reached[3]).toBe("ds");
  });

  it("leaves the Engine's draw functions its own outside a layer pass, and puts the same fixed-arity wrappers on in each", () => {
    const { babylon, tracker, original } = engine();
    expect(babylon.drawElementsType).toBe(original.drawElements);
    expect(babylon.drawArraysType).toBe(original.drawArrays);
    tracker.beginLayerPass();
    const wrappers = [babylon.drawElementsType, babylon.drawArraysType];
    // Made once, with the draws' own arity: no arguments array per call.
    expect(wrappers.map((wrapper) => wrapper.length)).toEqual([4, 4]);
    tracker.endLayerPass();
    expect(babylon.drawElementsType).toBe(original.drawElements);
    expect(babylon.drawArraysType).toBe(original.drawArrays);
    tracker.beginLayerPass();
    expect([babylon.drawElementsType, babylon.drawArraysType]).toEqual(wrappers);
    expect(babylon.drawElementsType).toBe(wrappers[0]);
    tracker.endLayerPass();
    // Ending twice changes nothing.
    tracker.endLayerPass();
    expect(babylon.drawElementsType).toBe(original.drawElements);
  });
});

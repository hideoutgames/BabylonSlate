import { describe, expect, it } from "vitest";
import { BackbufferDepthTracker, type TrackedContext } from "./backbuffer-depth-tracker";

const COLOR = 0x4000, DEPTH = 0x100, STENCIL = 0x400;
const DEPTH_TEST = 0x0b71, STENCIL_TEST = 0x0b90, SCISSOR_TEST = 0x0c11;
const FRAMEBUFFER = 0x8d40, DRAW_FRAMEBUFFER = 0x8ca9;

/** A context standing in for WebGL: the clears that reached it, in order, as their masks. */
function context() {
  const reached: number[] = [];
  const noop = () => {};
  const gl: TrackedContext = {
    bindFramebuffer: noop, enable: noop, disable: noop, depthMask: noop, stencilMask: noop, stencilMaskSeparate: noop,
    clearDepth: noop, clearStencil: noop, clear: (mask) => { reached.push(mask); }, drawArrays: noop, drawElements: noop,
    blitFramebuffer: noop, invalidateFramebuffer: noop,
    getParameter: (name) => (name === 0x0b72 ? true : name === 0x0b98 || name === 0x8ca5 ? 0xff : name === 0x0b73 ? 1 : name === 0x0b91 ? 0 : null),
    isEnabled: () => false,
  };
  const tracker = new BackbufferDepthTracker(gl);
  /** A clear as Babylon issues it: its values, then the clear. */
  const clear = (mask: number, depth = 1, stencil = 0) => { gl.clearDepth(depth); gl.clearStencil(stencil); gl.clear(mask); };
  /** A layer's depth-stencil clear, with clears left out where exact. */
  const layerClear = () => {
    tracker.eliding = true;
    try { clear(DEPTH | STENCIL); } finally { tracker.eliding = false; }
  };
  return { gl, tracker, reached, clear, layerClear };
}

describe("the backbuffer depth tracker", () => {
  it("leaves out a layer's depth-stencil clear only while the backbuffer holds what that clear writes", () => {
    const { tracker, reached, clear, layerClear } = context();
    // Nothing known yet: the clear runs, and leaves the buffers cleared.
    layerClear();
    expect(reached).toEqual([DEPTH | STENCIL]);
    layerClear();
    expect(reached).toEqual([DEPTH | STENCIL]);
    expect(tracker.elided).toBe(1);
    // A clear to other values is not the one they hold.
    tracker.eliding = true;
    clear(DEPTH | STENCIL, 0.5);
    tracker.eliding = false;
    expect(reached).toEqual([DEPTH | STENCIL, DEPTH | STENCIL]);
    // Outside a layer pass every clear runs.
    clear(DEPTH | STENCIL, 0.5);
    expect(reached).toHaveLength(3);
  });

  it("keeps the colour of a world clear that also cleared depth and stencil, and leaves out the first layer's", () => {
    const { tracker, reached, clear, layerClear } = context();
    clear(COLOR | DEPTH | STENCIL);
    layerClear();
    expect(reached).toEqual([COLOR | DEPTH | STENCIL]);
    // A colour clear in a layer pass keeps its colour when its depth and stencil are left out.
    tracker.eliding = true;
    clear(COLOR | DEPTH | STENCIL);
    tracker.eliding = false;
    expect(reached).toEqual([COLOR | DEPTH | STENCIL, COLOR]);
    expect({ clears: tracker.clears, depthClears: tracker.depthClears, elided: tracker.elided }).toEqual({ clears: 2, depthClears: 1, elided: 2 });
  });

  it("clears again after a draw that writes depth or tests stencil, but not after one that only reads depth", () => {
    const { gl, reached, clear, layerClear } = context();
    clear(DEPTH | STENCIL);
    gl.enable(DEPTH_TEST);
    gl.depthMask(false);
    gl.drawElements();
    layerClear();
    // A depth test without depth writes leaves the depth as it was.
    expect(reached).toHaveLength(1);
    gl.depthMask(true);
    gl.drawElements();
    layerClear();
    expect(reached).toHaveLength(2);
    gl.disable(DEPTH_TEST);
    gl.drawArrays();
    layerClear();
    // Without the depth test a draw writes no depth.
    expect(reached).toHaveLength(2);
    gl.enable(STENCIL_TEST);
    gl.drawArrays();
    layerClear();
    expect(reached).toHaveLength(3);
  });

  it("knows the buffers cleared only after a clear of both that reached every pixel and bit", () => {
    for (const partial of [
      (gl: TrackedContext) => gl.enable(SCISSOR_TEST),
      (gl: TrackedContext) => gl.depthMask(false),
      (gl: TrackedContext) => gl.stencilMask(0x0f),
      (gl: TrackedContext) => gl.stencilMaskSeparate(0x0405, 0x7f),
    ]) {
      const { gl, reached, clear, layerClear } = context();
      partial(gl);
      clear(DEPTH | STENCIL);
      layerClear();
      expect(reached).toHaveLength(2);
    }
    // Depth alone leaves the stencil unknown.
    const { reached, clear, layerClear } = context();
    clear(DEPTH);
    layerClear();
    expect(reached).toHaveLength(2);
  });

  it("follows only the default framebuffer, and forgets it at a depth blit, an invalidate or a new frame", () => {
    const { gl, tracker, reached, clear, layerClear } = context();
    clear(DEPTH | STENCIL);
    // Another target's draws and clears change nothing of the backbuffer's.
    gl.bindFramebuffer(FRAMEBUFFER, {});
    gl.enable(DEPTH_TEST);
    gl.drawElements();
    clear(DEPTH | STENCIL, 0.25);
    gl.bindFramebuffer(FRAMEBUFFER, null);
    layerClear();
    expect(reached).toEqual([DEPTH | STENCIL, DEPTH | STENCIL]);
    // A target's clear in a layer pass always runs.
    gl.bindFramebuffer(DRAW_FRAMEBUFFER, {});
    layerClear();
    gl.bindFramebuffer(DRAW_FRAMEBUFFER, null);
    expect(reached).toHaveLength(3);
    for (const forget of [
      () => gl.blitFramebuffer!(0, 0, 1, 1, 0, 0, 1, 1, DEPTH),
      () => gl.invalidateFramebuffer!(FRAMEBUFFER, [0x1801]),
      () => tracker.forget(),
    ]) {
      const before = reached.length;
      clear(DEPTH | STENCIL);
      forget();
      layerClear();
      expect(reached.length - before).toBe(2);
    }
    // A colour blit leaves depth and stencil as they were.
    clear(DEPTH | STENCIL);
    gl.blitFramebuffer!(0, 0, 1, 1, 0, 0, 1, 1, COLOR);
    const before = reached.length;
    layerClear();
    expect(reached.length).toBe(before);
  });
});

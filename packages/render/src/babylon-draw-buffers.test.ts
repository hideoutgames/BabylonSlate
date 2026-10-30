import { describe, expect, it, vi } from "vitest";
import { ThinEngine } from "@babylonjs/core/Engines/thinEngine";
import "@babylonjs/core/Engines/Extensions/engine.multiRender";
import { MaterialHelperGeometryRendering } from "@babylonjs/core/Materials/materialHelper.geometryrendering";

const COLOR0 = 0x8ce0;
const COLOR1 = 0x8ce1;
const NONE = 0;

/** The engine state the patched `bindAttachments` and resolves read, over a GL that records its calls. */
function engine() {
  const gl = {
    NONE, READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, COLOR_BUFFER_BIT: 0x4000, NEAREST: 0x2600,
    COLOR_ATTACHMENT0: COLOR0, COLOR_ATTACHMENT1: COLOR1,
    UNSIGNED_SHORT: 0x1403, FRAMEBUFFER: 0x8d40,
    drawBuffers: vi.fn(), bindFramebuffer: vi.fn(), blitFramebuffer: vi.fn(), readBuffer: vi.fn(), drawElements: vi.fn(),
  };
  // ThinEngine's own methods over only the state they read.
  const state = Object.assign(Object.create(ThinEngine.prototype) as object, {
    _gl: gl, _webGLVersion: 2, _currentFramebuffer: null as object | null, _currentRenderTarget: null, currentRenderPassId: 7,
    _uintIndicesCurrentlySet: false, applyStates: vi.fn(), _reportDrawCall: vi.fn(), _drawMode: () => 4,
  });
  const bind = (attachments: number[]) => ThinEngine.prototype.bindAttachments.call(state as unknown as ThinEngine, attachments);
  return { gl, state, bind };
}

describe("patched bindAttachments", () => {
  it("skips a draw buffers call that repeats what the bound framebuffer holds", () => {
    const { gl, state, bind } = engine();
    const target = {};
    state._currentFramebuffer = target;
    // A pass with a geometry configuration binds its attachments for each draw and restores its colour ones after.
    for (let draw = 0; draw < 3; draw++) {
      bind([COLOR0, COLOR1]);
      bind([COLOR0, NONE]);
    }
    expect(gl.drawBuffers.mock.calls).toEqual([[[COLOR0, COLOR1]], [[COLOR0, NONE]], [[COLOR0, COLOR1]], [[COLOR0, NONE]], [[COLOR0, COLOR1]], [[COLOR0, NONE]]]);
    gl.drawBuffers.mockClear();
    // The same list again on the same framebuffer: its state already holds it.
    bind([COLOR0, NONE]);
    bind([COLOR0, NONE]);
    expect(gl.drawBuffers).not.toHaveBeenCalled();
  });

  it("keeps each framebuffer's draw buffers apart, the default framebuffer included", () => {
    const { gl, state, bind } = engine();
    const first = {}, second = {};
    state._currentFramebuffer = first;
    bind([COLOR0, COLOR1]);
    state._currentFramebuffer = second;
    bind([COLOR0, COLOR1]);
    state._currentFramebuffer = null;
    bind([COLOR0]);
    state._currentFramebuffer = first;
    bind([COLOR0, COLOR1]);
    state._currentFramebuffer = null;
    bind([COLOR0]);
    expect(gl.drawBuffers).toHaveBeenCalledTimes(3);
  });

  it("asks GL again after a resolve binds a framebuffer of its own", () => {
    const { gl, state, bind } = engine();
    const msaa = {}, resolved = {};
    state._currentFramebuffer = msaa;
    bind([COLOR0, COLOR1]);
    // A single target's resolve leaves the draw binding on its resolved framebuffer, not `_currentFramebuffer`'s.
    ThinEngine.prototype.resolveFramebuffer.call(state as unknown as ThinEngine,
      { _MSAAFramebuffer: msaa, _framebuffer: resolved, isMulti: false, resolveMSAAColors: true, width: 4, height: 4 } as never);
    bind([COLOR0, COLOR1]);
    expect(gl.drawBuffers).toHaveBeenCalledTimes(2);
    // A multi target's resolve sets draw buffers itself.
    ThinEngine.prototype.resolveMultiFramebuffer.call(state as unknown as ThinEngine,
      { _MSAAFramebuffer: msaa, _framebuffer: resolved, isMulti: true, resolveMSAAColors: true, _attachments: [COLOR0, COLOR1],
        textures: [{ width: 4, height: 4 }, { width: 4, height: 4 }] } as never);
    gl.drawBuffers.mockClear();
    bind([COLOR0, COLOR1]);
    expect(gl.drawBuffers).toHaveBeenCalledTimes(1);
  });
});

describe("patched attachments restore", () => {
  /** A pass whose geometry configuration writes three targets, its colour attachments none of them. */
  function geometryPass() {
    const setup = engine();
    const configurations = (MaterialHelperGeometryRendering as unknown as { _Configurations: Record<number, unknown> })._Configurations;
    configurations[7] = { _attachments: [COLOR0, COLOR1, COLOR1 + 1], _colorAttachments: [NONE, NONE, NONE], defines: {} };
    const thin = setup.state as unknown as ThinEngine;
    /** One mesh draw as `Mesh.render` makes it: its effect's attachments, the draw, the restore. */
    const meshDraw = (multiTarget = true) => {
      MaterialHelperGeometryRendering._BindAttachmentsForEffect(thin, { _multiTarget: multiTarget } as never);
      ThinEngine.prototype.drawElementsType.call(thin, 0, 0, 3);
      MaterialHelperGeometryRendering._RestoreAttachments(thin);
    };
    return { ...setup, thin, meshDraw, release: () => delete configurations[7] };
  }

  it("sets a pass's draw buffers once for its multi target draws, not twice per draw", () => {
    const { gl, state, meshDraw, release } = geometryPass();
    state._currentFramebuffer = {};
    for (let draw = 0; draw < 5; draw++) meshDraw();
    expect(gl.drawElements).toHaveBeenCalledTimes(5);
    expect(gl.drawBuffers.mock.calls).toEqual([[[COLOR0, COLOR1, COLOR1 + 1]]]);
    release();
  });

  it("binds the restored attachments before a draw that binds none of its own, and before leaving the framebuffer", () => {
    const { gl, state, thin, meshDraw, release } = geometryPass();
    const pass = {};
    state._currentFramebuffer = pass;
    meshDraw();
    gl.drawBuffers.mockClear();
    // A draw outside `Mesh.render` (a post-process quad, a helper) writes the pass's colour attachments.
    ThinEngine.prototype.drawElementsType.call(thin, 0, 0, 3);
    expect(gl.drawBuffers.mock.calls).toEqual([[[NONE, NONE, NONE]]]);
    meshDraw();
    gl.drawBuffers.mockClear();
    // Leaving the framebuffer binds the restore into it first, so the next user of it finds its colour attachments.
    ThinEngine.prototype._bindUnboundFramebuffer.call(thin, null);
    expect(gl.drawBuffers.mock.calls).toEqual([[[NONE, NONE, NONE]]]);
    expect(gl.drawBuffers.mock.invocationCallOrder[0]!).toBeLessThan(gl.bindFramebuffer.mock.invocationCallOrder.at(-1)!);
    expect(state._currentFramebuffer).toBeNull();
    release();
  });

  it("draws an effect without multiple targets into the colour attachments at once", () => {
    const { gl, state, meshDraw, release } = geometryPass();
    state._currentFramebuffer = {};
    meshDraw();
    meshDraw(false);
    expect(gl.drawBuffers.mock.calls).toEqual([[[COLOR0, COLOR1, COLOR1 + 1]], [[NONE, NONE, NONE]]]);
    release();
  });
});

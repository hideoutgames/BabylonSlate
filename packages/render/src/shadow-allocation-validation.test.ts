import { describe, expect, it, vi } from "vitest";
import {
  NullEngine,
  type AbstractEngine,
  type ShadowGenerator,
} from "@babylonjs/core";
import { beginShadowAllocationValidation } from "./shadow-allocation-validation";

// The GPU boundary models independent WebGL2 read/draw bindings and attachment
// slices. Controller integration tests retain Babylon's actual generator path.
function fixture(kind: "2d" | "cube" | "array" = "cube", webgl2 = true) {
  const originalDraw = { name: "sibling-draw" };
  const originalRead = { name: "sibling-read" };
  const targetFramebuffer = { name: "shadow" };
  const color = { name: "color" };
  const depth = { name: "depth" };
  const attachments = new Map<number, { texture: object; slice: number }>();
  const state = {
    draw: originalDraw as object | null,
    read: (webgl2 ? originalRead : originalDraw) as object | null,
    errors: [] as number[],
    checkedSlices: [] as number[],
    incompleteSlice: -1,
    errorDuringCheck: 0,
    deleted: [] as object[],
  };
  const gl = {
    NO_ERROR: 0,
    INVALID_ENUM: 0x0500,
    OUT_OF_MEMORY: 0x0505,
    CONTEXT_LOST_WEBGL: 0x9242,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_BINDING: 0x8ca6,
    DRAW_FRAMEBUFFER: 0x8ca9,
    DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
    READ_FRAMEBUFFER: 0x8ca8,
    READ_FRAMEBUFFER_BINDING: 0x8caa,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    DEPTH_STENCIL_ATTACHMENT: 0x821a,
    RENDERBUFFER: 0x8d41,
    TEXTURE_2D: 0x0de1,
    TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
    getError: vi.fn(() => state.errors.shift() ?? 0),
    isContextLost: () => false,
    isTexture: (texture: object) => texture === color || texture === depth,
    isFramebuffer: (framebuffer: object) => framebuffer === targetFramebuffer,
    isRenderbuffer: (renderbuffer: object) => renderbuffer === depth,
    getParameter: (parameter: number): object | null =>
      parameter === gl.READ_FRAMEBUFFER_BINDING ? state.read : state.draw,
    createFramebuffer: vi.fn((): object | null => ({ name: "probe" })),
    deleteFramebuffer: (framebuffer: object) => {
      state.deleted.push(framebuffer);
    },
    bindFramebuffer: (target: number, framebuffer: object | null) => {
      if (target !== gl.READ_FRAMEBUFFER) state.draw = framebuffer;
      if (target !== gl.DRAW_FRAMEBUFFER) state.read = framebuffer;
    },
    framebufferTexture2D: (
      _target: number,
      attachment: number,
      textureTarget: number,
      texture: object,
    ) => {
      attachments.set(attachment, {
        texture,
        slice:
          textureTarget === gl.TEXTURE_2D
            ? 0
            : textureTarget - gl.TEXTURE_CUBE_MAP_POSITIVE_X,
      });
    },
    framebufferRenderbuffer: (
      _target: number,
      attachment: number,
      _kind: number,
      texture: object,
    ) => {
      attachments.set(attachment, { texture, slice: -1 });
    },
    checkFramebufferStatus: vi.fn((): number => {
      expect(state.draw).not.toBe(originalDraw);
      expect(state.draw).not.toBe(targetFramebuffer);
      const colorAttachment = attachments.get(gl.COLOR_ATTACHMENT0);
      const depthAttachment = attachments.get(gl.DEPTH_ATTACHMENT);
      if (
        colorAttachment?.texture !== color ||
        depthAttachment?.texture !== depth ||
        (depthAttachment.slice !== -1 &&
          depthAttachment.slice !== colorAttachment.slice)
      ) {
        return gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      }
      state.checkedSlices.push(colorAttachment.slice);
      if (state.errorDuringCheck) state.errors.push(state.errorDuringCheck);
      return colorAttachment.slice === state.incompleteSlice
        ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT
        : gl.FRAMEBUFFER_COMPLETE;
    }),
  };
  if (webgl2)
    Object.assign(gl, {
      framebufferTextureLayer: (
        _target: number,
        attachment: number,
        texture: object,
        _level: number,
        slice: number,
      ) => {
        attachments.set(attachment, { texture, slice });
      },
    });
  const engine = { _gl: gl } as unknown as AbstractEngine;
  const target = {
    _framebuffer: targetFramebuffer as object | null,
    texture: {
      _hardwareTexture: { underlyingResource: color as object | null },
    },
    depthStencilTexture: {
      _hardwareTexture: { underlyingResource: depth as object | null },
    } as { _hardwareTexture: { underlyingResource: object | null } } | null,
    _depthStencilBuffer: null as object | null,
    depthStencilTextureWithStencil: false,
    _generateStencilBuffer: false,
    isCube: kind === "cube",
    is2DArray: kind === "array",
    layers: kind === "array" ? 4 : 0,
  };
  const generator = {
    getLight: () => ({ getScene: () => ({ getEngine: () => engine }) }),
    getShadowMap: () => ({ renderTarget: target }),
  } as unknown as ShadowGenerator;
  const expectRestored = () => {
    expect(state.draw).toBe(originalDraw);
    expect(state.read).toBe(webgl2 ? originalRead : originalDraw);
    expect(target._framebuffer).toBe(targetFramebuffer);
    expect(state.deleted).toHaveLength(1);
  };
  return { gl, engine, generator, target, state, depth, expectRestored };
}

describe("shadow allocation validation", () => {
  it("does no WebGL validation on NullEngine", () => {
    const engine = new NullEngine();
    try {
      const generator = {
        getShadowMap: () => {
          throw new Error("must not inspect WebGL handles");
        },
      };
      expect(() =>
        beginShadowAllocationValidation(engine)(
          generator as unknown as ShadowGenerator,
        ),
      ).not.toThrow();
    } finally {
      engine.dispose();
    }
  });

  it("excludes earlier GL errors while rejecting a non-throwing allocation OOM", () => {
    const { gl, engine, generator, state } = fixture();
    state.errors.push(gl.INVALID_ENUM);
    const validate = beginShadowAllocationValidation(engine);
    state.errors.push(gl.OUT_OF_MEMORY);
    expect(() => validate(generator)).toThrow(
      /allocation WebGL errors: 0x505; pre-existing WebGL errors \(excluded\): 0x500/,
    );
    expect(gl.createFramebuffer).not.toHaveBeenCalled();
  });

  it("does not downgrade valid storage because an earlier operation set a GL error", () => {
    const { gl, engine, generator, state, expectRestored } = fixture();
    state.errors.push(gl.OUT_OF_MEMORY);
    expect(() =>
      beginShadowAllocationValidation(engine)(generator),
    ).not.toThrow();
    expectRestored();
  });

  it("bounds a continuously dirty error queue without blaming it on this allocation", () => {
    const { gl, engine, generator, expectRestored } = fixture();
    gl.getError.mockImplementation(() => gl.INVALID_ENUM);
    expect(() =>
      beginShadowAllocationValidation(engine)(generator),
    ).not.toThrow();
    expect(gl.getError.mock.calls.length).toBeLessThanOrEqual(48);
    expectRestored();
  });

  it.each(["framebuffer", "color", "depth"] as const)(
    "rejects a missing %s allocation even if Babylon marked it ready",
    (missing) => {
      const { engine, generator, target } = fixture();
      if (missing === "framebuffer") target._framebuffer = null;
      else if (missing === "color")
        target.texture._hardwareTexture.underlyingResource = null;
      else
        target.depthStencilTexture!._hardwareTexture.underlyingResource = null;
      expect(() => beginShadowAllocationValidation(engine)(generator)).toThrow(
        /missing or invalid/,
      );
    },
  );

  it.each([
    ["2d", [0]],
    ["cube", [0, 1, 2, 3, 4, 5]],
    ["array", [0, 1, 2, 3]],
  ] as const)(
    "validates every %s slice and restores sibling bindings",
    (kind, slices) => {
      const { engine, generator, state, expectRestored } = fixture(kind);
      beginShadowAllocationValidation(engine)(generator);
      expect(state.checkedSlices).toEqual(slices);
      expectRestored();
    },
  );

  it.each(["cube", "array"] as const)(
    "rejects an incomplete later %s slice and restores bindings",
    (kind) => {
      const { engine, generator, state, expectRestored } = fixture(kind);
      state.incompleteSlice = 3;
      expect(() => beginShadowAllocationValidation(engine)(generator)).toThrow(
        /incomplete at slice 3/,
      );
      expectRestored();
    },
  );

  it("validates WebGL1 depth renderbuffers without changing the framebuffer binding", () => {
    const { engine, generator, target, depth, expectRestored } = fixture(
      "cube",
      false,
    );
    target.depthStencilTexture = null;
    target._depthStencilBuffer = depth;
    beginShadowAllocationValidation(engine)(generator);
    expectRestored();
  });

  it("rejects allocation errors raised while probing otherwise complete attachments", () => {
    const { gl, engine, generator, state, expectRestored } = fixture();
    state.errorDuringCheck = gl.OUT_OF_MEMORY;
    expect(() => beginShadowAllocationValidation(engine)(generator)).toThrow(
      /validation WebGL errors: 0x505/,
    );
    expectRestored();
  });

  it("rejects a null probe framebuffer without rebinding the shared default target", () => {
    const { gl, engine, generator, state } = fixture();
    const original = { draw: state.draw, read: state.read };
    gl.createFramebuffer.mockReturnValue(null);
    expect(() => beginShadowAllocationValidation(engine)(generator)).toThrow(
      /validation framebuffer allocation failed/,
    );
    expect({ draw: state.draw, read: state.read }).toEqual(original);
    expect(state.deleted).toHaveLength(0);
  });
});

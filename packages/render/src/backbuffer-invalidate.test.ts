import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { describe, expect, it } from "vitest";
import { invalidateBackbufferDepthStencil } from "./backbuffer-invalidate";

describe("invalidateBackbufferDepthStencil", () => {
  const context = () => {
    const calls: [number, number[]][] = [];
    const gl = { FRAMEBUFFER: 0x8d40, DEPTH: 0x1801, STENCIL: 0x1802, invalidateFramebuffer: (target: number, attachments: number[]) => { calls.push([target, attachments]); } };
    return { gl, calls };
  };
  const engine = (gl: unknown, webGLVersion: number, bound: object | null) =>
    ({ _gl: gl, webGLVersion, _currentFramebuffer: bound }) as unknown as AbstractEngine;

  it("invalidates the default framebuffer's depth and stencil, never its colour, while it is the bound framebuffer", () => {
    const { gl, calls } = context();
    expect(invalidateBackbufferDepthStencil(engine(gl, 2, null))).toBe(true);
    expect(calls).toEqual([[0x8d40, [0x1801, 0x1802]]]);
  });

  it("does nothing while another framebuffer is bound, on WebGL1 and without a context", () => {
    const { gl, calls } = context();
    expect(invalidateBackbufferDepthStencil(engine(gl, 2, {}))).toBe(false);
    expect(invalidateBackbufferDepthStencil(engine(gl, 1, null))).toBe(false);
    expect(invalidateBackbufferDepthStencil(engine(undefined, 2, null))).toBe(false);
    expect(calls).toEqual([]);
  });
});

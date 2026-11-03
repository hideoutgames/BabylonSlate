import { describe, expect, it } from "vitest";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import "@babylonjs/core/Shaders/particles.vertex";
import "@babylonjs/core/ShadersWGSL/particles.vertex";
import type { ParticleSpriteSheetSettings } from "@haptic/particle-graph";
import { animatedSpriteCell } from "./particle-sprite-sheet";

const sheet = (settings: Partial<ParticleSpriteSheetSettings> = {}): ParticleSpriteSheetSettings => ({
  columns: 4, rows: 4, startCell: 2, endCell: 5, framesPerSecond: 10, loop: true, randomStartCell: false, ...settings,
});

describe("animatedSpriteCell", () => {
  it("steps Frames Per Second cells a second from the first cell and loops back to Start Cell", () => {
    const cells = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5].map((age) => animatedSpriteCell(sheet(), 2, age));
    expect(cells).toEqual([2, 2, 3, 4, 5, 2, 3]);
    // Whole frames stay whole after 1/60 s steps accumulate.
    let age = 0;
    for (let frame = 0; frame < 6; frame += 1) age += 1 / 60;
    expect(animatedSpriteCell(sheet(), 2, age)).toBe(3);
  });

  it("holds End Cell without Loop, starts from a random first cell, and holds the first cell at 0 fps", () => {
    expect([0, 0.2, 1, 9].map((age) => animatedSpriteCell(sheet({ loop: false }), 2, age))).toEqual([2, 4, 5, 5]);
    expect([0, 0.1, 0.2].map((age) => animatedSpriteCell(sheet(), 4, age))).toEqual([4, 5, 2]);
    expect(animatedSpriteCell(sheet({ framesPerSecond: 0 }), 4, 3)).toBe(4);
  });
});

describe("patched particle vertex shader", () => {
  // Babylon maps a sheet as if its texture were not flipped on upload; Haptic's Textures are
  // (invertY), so the patch flips V after the sheet maths: cell 0 at the top left, cells upright.
  it("flips V after the animation sheet maths in GLSL and WGSL", () => {
    const glsl = ShaderStore.ShadersStore.particlesVertexShader!;
    const wgsl = ShaderStore.ShadersStoreWGSL.particlesVertexShader!;
    expect(glsl).toContain("vUV=(uvOffset+vec2(columnOffset,rowOffset))*uvScale;vUV.y=1.0-vUV.y;");
    expect(wgsl).toContain("vertexOutputs.vUV=(uvOffset+ vec2f(columnOffset,rowOffset))*uvScale;vertexOutputs.vUV.y=1.0-vertexOutputs.vUV.y;");
    // Without a sheet the particle UV is untouched.
    expect(glsl).toContain("#else\nvUV=offset;");
  });
});

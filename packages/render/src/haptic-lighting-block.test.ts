import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { Scene } from "@babylonjs/core/scene";
import { isGeometryPassWithoutColor } from "./geometry-surface-output-block";
import { HapticLightingBlock } from "./haptic-lighting-block";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

/** Babylon's defines text: a boolean as `#define NAME`, a number as `#define NAME value`. */
const defines = (...lines: string[]) => lines.map((line) => `#define ${line}\n`).join("");

describe("isGeometryPassWithoutColor", () => {
  it.each([
    ["the view depth first, no colour", defines("PREPASS", "PREPASS_DEPTH", "PREPASS_DEPTH_INDEX 0"), true],
    ["normals first, beside the view depth", defines("PREPASS", "PREPASS_WORLD_NORMAL", "PREPASS_WORLD_NORMAL_INDEX 0", "PREPASS_DEPTH", "PREPASS_DEPTH_INDEX 1"), true],
    ["the normalized view depth first", defines("PREPASS", "PREPASS_NORMALIZED_VIEW_DEPTH", "PREPASS_NORMALIZED_VIEW_DEPTH_INDEX 0"), true],
    ["reflectivity first", defines("PREPASS", "PREPASS_REFLECTIVITY", "PREPASS_REFLECTIVITY_INDEX 0"), true],
    ["a colour output", defines("PREPASS", "PREPASS_COLOR", "PREPASS_COLOR_INDEX 0", "PREPASS_DEPTH", "PREPASS_DEPTH_INDEX 1"), false],
    ["a caller target first (an object id)", defines("PREPASS", "PREPASS_DEPTH", "PREPASS_DEPTH_INDEX 1"), false],
    ["index 10, not 0", defines("PREPASS", "PREPASS_DEPTH", "PREPASS_DEPTH_INDEX 10"), false],
    ["no geometry configuration", defines("PREPASS_DEPTH", "PREPASS_DEPTH_INDEX 0"), false],
    ["a colour pass", defines("HAPTIC_ENVIRONMENT", "NORMAL"), false],
  ])("%s: %s", (_name, text, expected) => {
    expect(isGeometryPassWithoutColor(text)).toBe(expected);
  });
});

describe("HapticLightingBlock bindings", () => {
  /** An Effect that records what a draw binds on it: textures, uniforms and uniform blocks. */
  function effect(text: string) {
    const calls: string[] = [];
    const record = (kind: string) => (name: string) => { calls.push(`${kind} ${name}`); };
    const fake = {
      defines: text,
      setTexture: vi.fn(record("texture")),
      setDepthStencilTexture: vi.fn(record("depth texture")),
      setFloat: vi.fn(record("float")),
      setFloat4: vi.fn(record("float4")),
      setMatrix: vi.fn(record("matrix")),
      bindUniformBuffer: vi.fn((_buffer: unknown, name: string) => { calls.push(`block ${name}`); }),
    };
    return { effect: fake as unknown as Effect, calls };
  }

  function draw() {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const mesh = MeshBuilder.CreateBox("box", {}, scene);
    mesh.receiveShadows = true;
    const block = new HapticLightingBlock("lighting");
    block.noEnvironment = true;
    return { block, mesh, material: {} as NodeMaterial };
  }

  it("binds only the light and cluster blocks for a geometry pass program without a colour output, on its draws or a frozen Material's rebind", () => {
    const { block, mesh, material } = draw();
    const geometry = effect(defines("PREPASS", "PREPASS_DEPTH", "PREPASS_DEPTH_INDEX 0"));
    block.bind(geometry.effect, material, mesh);
    // Its std140 blocks stay active: a draw without them bound fails.
    expect(geometry.calls).toEqual(["block HapticLights", "block HapticClusters"]);
    geometry.calls.length = 0;
    block.bindReceiver(geometry.effect, mesh);
    expect(geometry.calls).toEqual(["block HapticLights", "block HapticClusters"]);
  });

  it("binds every input a colour pass program reads, the receiver terms on a frozen Material's rebind", () => {
    const { block, mesh, material } = draw();
    const colour = effect(defines("NORMAL"));
    block.bind(colour.effect, material, mesh);
    // The control: what the geometry pass's draws no longer bind.
    expect(colour.calls).toEqual(expect.arrayContaining([
      "block HapticLights", "block HapticClusters", "texture hapticAreaLtcSampler", "texture hapticAreaEmissionSampler", "depth texture hapticShadowAtlas",
      "float hapticShadowReceiver", "texture hapticEnvironmentBrdfSampler",
    ]));
    colour.calls.length = 0;
    block.bindReceiver(colour.effect, mesh);
    expect(colour.calls).toContain("float hapticShadowReceiver");
  });
});

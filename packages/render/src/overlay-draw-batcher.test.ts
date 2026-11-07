import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sceneDrawBatcher } from "./draw-batching";
import { beginEngineDrawCallFrame } from "./draw-calls";
import { beginDrawPassFrame, DrawPassFrame, endDrawPassFrame, publishDrawPassFrame, withDrawPass } from "./draw-passes";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { setSceneDrawBatching } from "./overlay-draw-batcher";
import { OverlayLayoutRenderer } from "./overlay-layout-render";
import { applyOverlayUnlitMaterial } from "./overlay-texture-quad";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { buildSceneLayerHud } from "./scene-layer-hud-fixture";
import { createSpriteQuad, setSpriteQuadSize, setSpriteQuadUvs } from "./sprite-quad";
import { setUnlitMaterial } from "./unlit-material";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A Play compositor with one Scene Layer, on a NullEngine whose draws count as WebGL2's do (one per draw call). */
function host() {
  const engine = adaptNullEngineFrameGraph(new NullEngine({
    renderWidth: 1280, renderHeight: 720, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1,
  }));
  engines.push(engine);
  engine.drawElementsType = function (this: NullEngine) { this._reportDrawCall(); };
  engine.drawArraysType = function (this: NullEngine) { this._reportDrawCall(); };
  const compositor = new SceneLayerCompositor({ engine });
  const layer = compositor.create({ type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0, ownerSceneGuid: null, postProcessStack: [] });
  return { engine, compositor, layer, scene: layer.scene };
}

/** One Engine frame of `draw`, as Play's loop runs it. */
function engineFrame(engine: NullEngine, draw: () => void): void {
  engine.beginFrame();
  try {
    draw();
  } finally {
    engine.endFrame();
  }
}

/** The draws of the last of `frames` frames the compositor drew, counted as Play counts them (`layers`). */
function layerDraws(engine: NullEngine, compositor: SceneLayerCompositor, frames = 3): number {
  const frame = new DrawPassFrame(engine);
  for (let index = 0; index < frames; index += 1) {
    engineFrame(engine, () => {
      beginEngineDrawCallFrame(engine);
      beginDrawPassFrame(frame);
      withDrawPass(engine, "layers", () => compositor.render());
      endDrawPassFrame(frame);
      publishDrawPassFrame(frame);
    });
  }
  return frame.last.layers;
}

/** The meshes `Mesh.render` draws while `draw` runs. */
function drawnMeshes(draw: () => void): Mesh[] {
  const drawn: Mesh[] = [];
  const render = Mesh.prototype.render;
  const spy = vi.spyOn(Mesh.prototype, "render").mockImplementation(function (this: Mesh, ...args) {
    drawn.push(this);
    return render.apply(this, args);
  });
  try {
    draw();
  } finally {
    spy.mockRestore();
  }
  return drawn;
}

/** A flat unlit quad drawn as an overlay 2D Material is without an authored Material. */
function quad(scene: Scene, name: string, x: number, y: number, options: { z?: number; size?: number; tint?: [number, number, number, number] } = {}): Mesh {
  const mesh = MeshBuilder.CreatePlane(name, { size: 1 }, scene);
  applyOverlayUnlitMaterial(mesh);
  mesh.position.set(x, y, options.z ?? 0);
  mesh.scaling.setAll(options.size ?? 1);
  applyOverlayVisualStyle(mesh, { tint: options.tint ?? [0.2, 0.3, 0.5, 0.8] });
  return mesh;
}

/** A sprite as a Sprite component draws one: a quad its owner rewrites in place, cut out from its texture. */
function sprite(scene: Scene, name: string, x: number, texture: RawTexture): Mesh {
  const mesh = createSpriteQuad(scene, name, { pivot: { x: 0.5, y: 0.5 }, width: 64, height: 64 }, 100);
  setUnlitMaterial(mesh, { textured: true, backFaceCulling: true, fog: true, role: "world" },
    { texture, color: [1, 1, 1], alpha: 1, cutoff: 0.4, blend: false, textureAlpha: true, twoSided: false });
  mesh.position.x = x;
  return mesh;
}

/** The layer's draws batched, then one by one. */
async function drawsBothWays(context: ReturnType<typeof host>): Promise<{ batched: number; unbatched: number }> {
  const { engine, compositor, scene } = context;
  await compositor.prepare("hud", () => {});
  setSceneDrawBatching(scene, true);
  const batched = layerDraws(engine, compositor);
  setSceneDrawBatching(scene, false);
  const unbatched = layerDraws(engine, compositor);
  return { batched, unbatched };
}

describe("Scene Layer draw batching", () => {
  it("keeps each draw after every draw it overlaps", async () => {
    // Blended, back to front: a (farthest), b, c. a and c bind the same; b another tint.
    const context = host();
    quad(context.scene, "a", 0, 0, { z: 0.9 });
    const b = quad(context.scene, "b", 0.6, 0, { z: 0.5, tint: [0.9, 0.2, 0.1, 0.8] });
    const c = quad(context.scene, "c", 1.2, 0, { z: 0.1 });
    // b overlaps both: c must draw after b, so it cannot join a.
    expect(await drawsBothWays(context)).toEqual({ batched: 3, unbatched: 3 });
    // b over a only: c overlaps nothing drawn after a, and joins a.
    c.position.x = -1.2;
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 3 });
    // Edges that meet count as overlapping.
    b.position.x = 1;
    c.position.x = 2;
    expect(await drawsBothWays(context)).toEqual({ batched: 3, unbatched: 3 });
  });

  it("draws a turned member, and one whose scale rounds in 32 bits, on its own", async () => {
    const context = host();
    const quads = [-6, -3, 0, 3, 6].map((x, index) => quad(context.scene, `q${index}`, x, 0));
    expect(await drawsBothWays(context)).toEqual({ batched: 1, unbatched: 5 });
    quads[1]!.rotation.z = 0.2;
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 5 });
    // 0.15 × 0.7 has more bits than a 32-bit float holds: the vertex stage rounds it, so a baked copy could differ.
    const small = MeshBuilder.CreatePlane("small", { size: 0.3 }, context.scene);
    applyOverlayUnlitMaterial(small);
    applyOverlayVisualStyle(small, { tint: [0.2, 0.3, 0.5, 0.8] });
    small.position.set(-6, 3, 0);
    small.scaling.setAll(0.7);
    expect(await drawsBothWays(context)).toEqual({ batched: 3, unbatched: 6 });
    // A scale whose products stay exact batches.
    small.scaling.setAll(0.5);
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 6 });
  });

  it("shares a draw only between draws that bind the same values", async () => {
    const context = host();
    const quads = [-6, -3, 0, 3, 6].map((x, index) => quad(context.scene, `q${index}`, x, 0));
    applyOverlayVisualStyle(quads[1]!, { tint: [0.2, 0.3, 0.5, 0.6] });
    quads[2]!.visibility = 0.5;
    setUnlitMaterial(quads[3]!, { textured: false, backFaceCulling: false, fog: true, role: "world" },
      { texture: null, color: [1, 0.5, 0.5], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false });
    expect(await drawsBothWays(context)).toEqual({ batched: 4, unbatched: 5 });
    // The same values in another binding object share a draw.
    setUnlitMaterial(quads[3]!, { textured: false, backFaceCulling: false, fog: true, role: "world" },
      { texture: null, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false });
    expect(await drawsBothWays(context)).toEqual({ batched: 3, unbatched: 5 });
  });

  it("batches clipped draws per clip, each batch under its clip's scissor", async () => {
    const context = host();
    const { scene, engine } = context;
    const left = { x: -4, y: 0, width: 4, height: 2 }, right = { x: 4, y: 0, width: 4, height: 2 };
    const entries: Array<{ slotId: number; actorId: string; rect: typeof left; clip: typeof left; scrollAncestors: string[] }> = [];
    [-5, -4, -3, 3, 4, 5].forEach((x, index) => {
      const root = new Mesh(`actor-${index + 1}`, scene);
      quad(scene, `actor-${index + 1}|quad`, x, 0, { size: 0.5 }).parent = root;
      const clip = x < 0 ? left : right;
      entries.push({ slotId: index + 1, actorId: `actor-${index + 1}`, rect: clip, clip: { ...clip }, scrollAncestors: [] });
    });
    new OverlayLayoutRenderer(() => scene).apply({ type: "sceneLayerLayout", layerId: "hud", entries });
    const scissor = vi.spyOn(engine, "enableScissor");
    await context.compositor.prepare("hud", () => {});
    setSceneDrawBatching(scene, true);
    scissor.mockClear();
    expect(layerDraws(engine, context.compositor, 1)).toBe(2);
    const batched = scissor.mock.calls.map((call) => call.join());
    setSceneDrawBatching(scene, false);
    scissor.mockClear();
    expect(layerDraws(engine, context.compositor, 1)).toBe(6);
    const unbatched = scissor.mock.calls.map((call) => call.join());
    // One scissor per batch, the same rectangles each of its members' draws set.
    expect(batched).toHaveLength(2);
    expect(new Set(unbatched)).toEqual(new Set(batched));
  });

  it("writes a batch's vertices in eye-relative space, with a world that the floating origin uploads as zero", async () => {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    vi.spyOn(engine, "getCreationOptions").mockReturnValue({ useLargeWorldRendering: true });
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0, ownerSceneGuid: null, postProcessStack: [] });
    expect(layer.scene.floatingOriginMode).toBe(true);
    const first = quad(layer.scene, "first", 2.25, -1.5);
    const second = quad(layer.scene, "second", 5.5, 1.25, { size: 2 });
    await compositor.prepare("hud", () => {});
    const drawn = drawnMeshes(() => engineFrame(engine, () => compositor.render()));
    expect(drawn).toHaveLength(1);
    const batch = drawn[0]!;
    expect([first, second]).not.toContain(batch);
    // The layer camera sits at (0, 0, -10): the eye, which the floating origin subtracts from every world matrix.
    expect(batch.getWorldMatrix().getTranslation().asArray().map((value) => value + 0)).toEqual([0, 0, -10]);
    const positions = Array.from(batch.getVerticesData("position")!.slice(0, 24));
    // Back to front: the second quad is farther from the eye, and draws first.
    expect(positions).toEqual([
      4.5, 0.25, 10, 6.5, 0.25, 10, 6.5, 2.25, 10, 4.5, 2.25, 10,
      1.75, -2, 10, 2.75, -2, 10, 2.75, -1, 10, 1.75, -1, 10,
    ]);
    await compositor.dispose();
  });

  it("draws what an owner rewrote in place: a sprite's animation frame and size", async () => {
    const { engine, compositor, scene } = host();
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(64 * 64 * 4).fill(255), 64, 64, scene);
    const walker = sprite(scene, "walker", -2, texture);
    sprite(scene, "idle", 2, texture);
    await compositor.prepare("hud", () => {});
    const batchOf = () => {
      const drawn = drawnMeshes(() => layerDraws(engine, compositor, 1));
      expect(drawn).toHaveLength(1);
      return drawn[0]!;
    };
    const uvs = (mesh: Mesh) => Array.from(mesh.getVerticesData("uv")!.slice(0, 16));
    const xs = (mesh: Mesh) => Array.from(mesh.getVerticesData("position")!.slice(0, 24)).filter((_value, index) => index % 3 === 0);
    // Equally far, the two keep their order: idle, then walker.
    expect(uvs(batchOf())).toEqual([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
    // The sprite's next frame rewrites its UV array in place.
    setSpriteQuadUvs(walker, { u0: 0.5, v0: 0, u1: 0.75, v1: 0.25 });
    expect(uvs(batchOf())).toEqual([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0, 0.75, 0, 0.75, 0.25, 0.5, 0.25]);
    // A resize rewrites its position array in place. Each x is the sprite's 32-bit vertex plus its translation,
    // rounded once to 32 bits, as the vertex stage computes it: idle's corners are 2 ∓ 0.32, walker's -2 and -1.
    setSpriteQuadSize(walker, 1, 0.5, { x: 0, y: 0 });
    const half = Math.fround(0.32);
    expect(xs(batchOf())).toEqual([2 - half, 2 + half, 2 + half, 2 - half, -2, -1, -1, -2].map(Math.fround));
  });

  it("uses each batch mesh once per Engine frame, as WebGPU writes buffers ahead of the frame's draws", async () => {
    const { engine, compositor, scene } = host();
    const moving = quad(scene, "moving", -2, 0);
    quad(scene, "still", 2, 0);
    await compositor.prepare("hud", () => {});
    layerDraws(engine, compositor, 1);
    const writes = vi.spyOn(engine, "updateDynamicVertexBuffer");
    let batches: Mesh[] = [];
    engineFrame(engine, () => {
      batches = drawnMeshes(() => {
        compositor.render();
        // A second draw of the layer in the same Engine frame, after a change.
        moving.position.x = -3;
        compositor.render();
      });
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]).not.toBe(batches[1]);
    const written = writes.mock.calls.map(([buffer]) => buffer);
    expect(new Set(written).size).toBe(written.length);
  });

  it("draws a batch's members one by one while one of them is not ready, as Babylon draws them", async () => {
    const { engine, compositor, scene } = host();
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(64 * 64 * 4).fill(255), 64, 64, scene);
    const sprites = [-4, -2, 0, 2].map((x, index) => sprite(scene, `sprite${index}`, x, texture));
    await compositor.prepare("hud", () => {});
    expect(layerDraws(engine, compositor)).toBe(1);
    // A pass drawn while the Material is not ready for one sprite (a variant still compiling, which the layer's
    // renderer admits only in a tolerant round): Babylon skips that sprite's draw and draws the others.
    const material = sprites[0]!.material!;
    const isReady = material.isReadyForSubMesh.bind(material);
    const notReady = vi.spyOn(material, "isReadyForSubMesh")
      .mockImplementation((mesh, subMesh, useInstances) => mesh !== sprites[2] && isReady(mesh, subMesh, useInstances));
    const subMeshes = sprites.map((mesh) => mesh.subMeshes[0]!);
    const pass = () => {
      const draws = vi.spyOn(engine, "drawElementsType");
      const drawn = drawnMeshes(() => engineFrame(engine, () =>
        sceneDrawBatcher(scene)!.draw(subMeshes, subMeshes.length, false, (subMesh) => { subMesh.render(false); })));
      const count = draws.mock.calls.length;
      draws.mockRestore();
      return { draws: count, drawn: drawn.map((mesh) => mesh.name) };
    };
    expect(pass()).toEqual({ draws: 3, drawn: ["sprite0", "sprite1", "sprite2", "sprite3"] });
    // Ready again, the four share a draw.
    notReady.mockRestore();
    expect(pass()).toEqual({ draws: 1, drawn: ["drawBatch:0"] });
  });

  it("draws the Feature Test HUD in far fewer draws", async () => {
    const { engine, compositor, scene } = host();
    const textures = new Map<string, RawTexture>();
    const texture = (guid: string) => {
      let found = textures.get(guid);
      if (!found) textures.set(guid, (found = RawTexture.CreateRGBATexture(new Uint8Array(64 * 64 * 4).fill(255), 64, 64, scene)));
      return found;
    };
    // Tinted backgrounds draw an authored Material, as the Feature Test's do: those never batch.
    buildSceneLayerHud(scene, { texture, panelMaterial: new StandardMaterial("overlay", scene) });
    await compositor.prepare("hud", () => {});
    const meshes = scene.meshes.length;
    // Batching is on for every Scene Layer.
    const batched = layerDraws(engine, compositor);
    setSceneDrawBatching(scene, false);
    const unbatched = layerDraws(engine, compositor);
    expect({ batched, unbatched }).toEqual({ batched: 109, unbatched: 181 });
    // Batch meshes join no Scene list: nothing culls, picks, probes or counts them.
    expect(scene.meshes).toHaveLength(meshes);
    await compositor.dispose();
  });
});

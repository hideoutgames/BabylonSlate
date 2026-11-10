import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sceneDrawBatcher } from "./draw-batching";
import { beginEngineDrawCallFrame } from "./draw-calls";
import { beginDrawPassFrame, DrawPassFrame, endDrawPassFrame, publishDrawPassFrame, withDrawPass } from "./draw-passes";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { copyOverlayBatchStats, countOverlayBatches, emptyOverlayBatchStats, setSceneDrawBatching } from "./overlay-draw-batcher";
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

  it("batches a turned member and one whose scale rounds in 32 bits, and draws a mirrored one on its own", async () => {
    const context = host();
    const quads = [-6, -3, 0, 3, 6].map((x, index) => quad(context.scene, `q${index}`, x, 0));
    expect(await drawsBothWays(context)).toEqual({ batched: 1, unbatched: 5 });
    // A turned member's vertices are transformed by its own world matrix, which the batch carries with them.
    quads[1]!.rotation.z = 0.2;
    expect(await drawsBothWays(context)).toEqual({ batched: 1, unbatched: 5 });
    // 0.15 × 0.7 has more bits than a 32-bit float holds: the vertex stage rounds it, in a batch as in the quad's own draw.
    const small = MeshBuilder.CreatePlane("small", { size: 0.3 }, context.scene);
    applyOverlayUnlitMaterial(small);
    applyOverlayVisualStyle(small, { tint: [0.2, 0.3, 0.5, 0.8] });
    small.position.set(-6, 3, 0);
    small.scaling.setAll(0.7);
    expect(await drawsBothWays(context)).toEqual({ batched: 1, unbatched: 6 });
    // A mirrored member draws with its faces the other way round, which one draw of them all cannot.
    quads[3]!.scaling.x = -1;
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

  it("writes each member's own vertices with its world matrix as its draw uploads it, less the floating origin's eye", async () => {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    vi.spyOn(engine, "getCreationOptions").mockReturnValue({ useLargeWorldRendering: true });
    const compositor = new SceneLayerCompositor({ engine });
    const layer = compositor.create({ type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0, ownerSceneGuid: null, postProcessStack: [] });
    expect(layer.scene.floatingOriginMode).toBe(true);
    const first = quad(layer.scene, "first", 2.25, -1.5);
    const second = quad(layer.scene, "second", 5.5, 1.25, { size: 2 });
    const turned = quad(layer.scene, "turned", -4, 3, { z: 5 });
    turned.rotation.z = Math.PI / 2;
    // Panned, the layer camera sits at (1.5, -0.75, -10).
    compositor.setCamera("hud", { x: 1.5, y: -0.75, rotation: 0, zoom: 1 });
    await compositor.prepare("hud", () => {});
    const drawn = drawnMeshes(() => engineFrame(engine, () => compositor.render()));
    expect(drawn).toHaveLength(1);
    const batch = drawn[0]!;
    expect([first, second, turned]).not.toContain(batch);
    // Each member's vertices as its own buffer holds them: a unit plane's corners, whatever its pose.
    const corners = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
    expect(Array.from(batch.getVerticesData("position")!.slice(0, 36))).toEqual([...corners, ...corners, ...corners]);
    // With each vertex, its member's world matrix in rows, each ending in the translation. The camera's position is the
    // eye, which the floating origin subtracts from every translation. Back to front: the turned quad, the second, the first.
    const rows = (kind: string, member: number) => Array.from(batch.getVerticesData(kind)!.slice(member * 16, member * 16 + 16));
    const perVertex = (row: number[]) => [...row, ...row, ...row, ...row];
    const worldOf = (member: number) => ["batchWorld0", "batchWorld1", "batchWorld2"].map((kind) => rows(kind, member));
    expect(worldOf(1)).toEqual([[2, 0, 0, 4], [0, 2, 0, 2], [0, 0, 2, 10]].map(perVertex));
    expect(worldOf(2)).toEqual([[1, 0, 0, 0.75], [0, 1, 0, -0.75], [0, 0, 1, 10]].map(perVertex));
    // A quarter turn about z takes x to y and y to -x, as rounded to 32 bits as the member's own upload is.
    const uploaded = Array.from(new Float32Array(turned.getWorldMatrix().asArray()));
    const turnedWorld = worldOf(0);
    expect(turnedWorld).toEqual([
      [uploaded[0]!, uploaded[4]!, uploaded[8]!, -5.5], [uploaded[1]!, uploaded[5]!, uploaded[9]!, 3.75], [uploaded[2]!, uploaded[6]!, uploaded[10]!, 15],
    ].map(perVertex));
    expect(turnedWorld[1]![0]).toBeCloseTo(1, 6);
    expect(turnedWorld[0]![1]).toBeCloseTo(-1, 6);
    expect(Math.abs(turnedWorld[0]![0]!)).toBeLessThan(1e-6);
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
    const xs = (mesh: Mesh) => Array.from(mesh.getVerticesData("position")!.slice(0, 24)).filter((_value, index) => index % 3 === 0).map((x) => x + 0);
    // Equally far, the two keep their order: idle, then walker.
    expect(uvs(batchOf())).toEqual([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
    // The sprite's next frame rewrites its UV array in place.
    setSpriteQuadUvs(walker, { u0: 0.5, v0: 0, u1: 0.75, v1: 0.25 });
    expect(uvs(batchOf())).toEqual([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0, 0.75, 0, 0.75, 0.25, 0.5, 0.25]);
    // A resize rewrites its position array in place: idle's own corners are ∓0.32 (in 32 bits), walker's now 0 and 1.
    setSpriteQuadSize(walker, 1, 0.5, { x: 0, y: 0 });
    const half = Math.fround(0.32);
    expect(xs(batchOf())).toEqual([-half, half, half, -half, 0, 1, 1, 0]);
    // Where each stands is its world matrix's, with its vertices: idle at x = 2, walker at -2.
    const translations = Array.from(batchOf().getVerticesData("batchWorld0")!.slice(0, 32)).filter((_value, index) => index % 4 === 3);
    expect(translations).toEqual([2, 2, 2, 2, -2, -2, -2, -2]);
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

  it("counts a frame's visuals by how each drew: in a batch, or on its own and why", async () => {
    const { engine, compositor, scene } = host();
    // Blended, apart from each other. Three bind the same and share a draw.
    [-6, -3, 0].forEach((x, index) => quad(scene, `same${index}`, x, 0));
    // One of another tint: batchable, but nothing draws the same.
    quad(scene, "tinted", 3, 0, { tint: [0.9, 0.2, 0.1, 0.8] });
    quad(scene, "mirrored", 6, 0).scaling.x = -1;
    const authored = MeshBuilder.CreatePlane("authored", { size: 1 }, scene);
    authored.material = new StandardMaterial("authored", scene);
    authored.material.alpha = 0.5;
    authored.position.set(-6, 3, 0);
    quad(scene, "coloured", -3, 3).setVerticesData(VertexBuffer.ColorKind, new Array<number>(16).fill(1));
    quad(scene, "hooked", 0, 3).onBeforeRenderObservable.add(() => {});
    // The alpha-tested pass's only draw.
    sprite(scene, "sprite", 3, RawTexture.CreateRGBATexture(new Uint8Array(64 * 64 * 4).fill(255), 64, 64, scene)).position.y = 3;
    await compositor.prepare("hud", () => {});
    layerDraws(engine, compositor);
    const stats = emptyOverlayBatchStats();
    const draws = countOverlayBatches(stats, () => layerDraws(engine, compositor, 1));
    // Nine visuals: three in one draw, six in a draw each.
    expect(stats).toEqual({
      visuals: 9, draws: 7, batches: 1, batched: 3,
      alone: { single: 1, material: 1, transform: 1, vertexColor: 1, other: 1, unmatched: 1 },
    });
    expect(draws).toBe(7);
    // Every layer drawn meanwhile counts: a second one with two visuals that share a draw.
    const second = compositor.create({ type: "sceneLayerCreate", layerId: "second", assetGuid: "second", zOrder: 1, ownerSceneGuid: null, postProcessStack: [] });
    quad(second.scene, "a", -2, 0);
    quad(second.scene, "b", 2, 0);
    await compositor.prepare("second", () => {});
    layerDraws(engine, compositor);
    const both = emptyOverlayBatchStats();
    countOverlayBatches(both, () => layerDraws(engine, compositor, 1));
    expect(both).toMatchObject({ visuals: 11, draws: 8, batches: 2, batched: 5 });
  });

  it("counts only the passes drawn while asked to, adding to the counts it is given", async () => {
    const { engine, compositor, scene } = host();
    const quads = [-3, 0, 3].map((x, index) => quad(scene, `q${index}`, x, 0));
    await compositor.prepare("hud", () => {});
    const none = { single: 0, material: 0, transform: 0, vertexColor: 0, other: 0, unmatched: 0 };
    const stats = emptyOverlayBatchStats();
    // Frames drawn before and after the counted one leave the counts.
    layerDraws(engine, compositor);
    expect(countOverlayBatches(stats, () => layerDraws(engine, compositor, 1))).toBe(1);
    layerDraws(engine, compositor);
    expect(stats).toEqual({ visuals: 3, draws: 1, batches: 1, batched: 3, alone: none });
    // A second counted frame adds to them: three visuals again, one of them mirrored.
    quads[0]!.scaling.x = -1;
    countOverlayBatches(stats, () => layerDraws(engine, compositor, 1));
    expect(stats).toEqual({ visuals: 6, draws: 3, batches: 2, batched: 5, alone: { ...none, transform: 1 } });
    // Counting within a counted draw takes its own passes and hands back after it.
    const outer = emptyOverlayBatchStats(), inner = emptyOverlayBatchStats();
    countOverlayBatches(outer, () => {
      countOverlayBatches(inner, () => layerDraws(engine, compositor, 1));
      layerDraws(engine, compositor, 1);
      layerDraws(engine, compositor, 1);
    });
    expect({ inner: inner.visuals, outer: outer.visuals }).toEqual({ inner: 3, outer: 6 });
    // A pass with one batchable visual has nothing to batch it with.
    quads[1]!.scaling.x = -1;
    const lone = emptyOverlayBatchStats();
    countOverlayBatches(lone, () => layerDraws(engine, compositor, 1));
    expect(lone).toEqual({ visuals: 3, draws: 3, batches: 0, batched: 0, alone: { ...none, transform: 2, unmatched: 1 } });
    // A copy holds the counts as they were.
    const copy = copyOverlayBatchStats(lone);
    countOverlayBatches(lone, () => layerDraws(engine, compositor, 1));
    expect(copy).toEqual({ visuals: 3, draws: 3, batches: 0, batched: 0, alone: { ...none, transform: 2, unmatched: 1 } });
    expect(copyOverlayBatchStats(stats, copy)).toBe(copy);
    expect(copy).toEqual(stats);
  });

  it("counts a batch that cannot draw as one in a frame as its members' own draws", async () => {
    const { engine, compositor, scene } = host();
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(64 * 64 * 4).fill(255), 64, 64, scene);
    const sprites = [-4, -2, 0, 2].map((x, index) => sprite(scene, `sprite${index}`, x, texture));
    await compositor.prepare("hud", () => {});
    const material = sprites[0]!.material!;
    const isReady = material.isReadyForSubMesh.bind(material);
    vi.spyOn(material, "isReadyForSubMesh").mockImplementation((mesh, subMesh, useInstances) => mesh !== sprites[2] && isReady(mesh, subMesh, useInstances));
    const subMeshes = sprites.map((mesh) => mesh.subMeshes[0]!);
    const stats = emptyOverlayBatchStats();
    countOverlayBatches(stats, () => engineFrame(engine, () =>
      sceneDrawBatcher(scene)!.draw(subMeshes, subMeshes.length, false, (subMesh) => { subMesh.render(false); })));
    expect(stats).toEqual({
      visuals: 4, draws: 4, batches: 0, batched: 0,
      alone: { single: 0, material: 0, transform: 0, vertexColor: 0, other: 0, unmatched: 4 },
    });
  });

  it("draws members one by one unless one program, but for the batch's define, draws them all", async () => {
    const { engine, compositor, scene } = host();
    scene.fogMode = Scene.FOGMODE_LINEAR;
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(64 * 64 * 4).fill(255), 64, 64, scene);
    const sprites = [-4, -2, 0, 2].map((x, index) => sprite(scene, `sprite${index}`, x, texture));
    const draws = async () => {
      await compositor.prepare("hud", () => {});
      return layerDraws(engine, compositor);
    };
    expect(await draws()).toBe(1);
    // One member draws without fog, with a program of its own: no one program draws the four.
    sprites[1]!.applyFog = false;
    expect(await draws()).toBe(4);
    // All without fog share a program, but the batch's mesh, which fogs, compiles another than theirs with its define.
    for (const mesh of sprites) mesh.applyFog = false;
    expect(await draws()).toBe(4);
    for (const mesh of sprites) mesh.applyFog = true;
    expect(await draws()).toBe(1);
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
    // The unevenly scaled cards' and the turned widgets' unlit visuals batch with the rest: each carries its own pose.
    expect({ batched, unbatched }).toEqual({ batched: 61, unbatched: 195 });
    // Batch meshes join no Scene list: nothing culls, picks, probes or counts them.
    expect(scene.meshes).toHaveLength(meshes);
    await compositor.dispose();
  });
});

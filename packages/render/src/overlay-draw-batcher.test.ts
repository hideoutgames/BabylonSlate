import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sceneDrawBatcher } from "./draw-batching";
import { beginEngineDrawCallFrame } from "./draw-calls";
import { beginDrawPassFrame, DrawPassFrame, endDrawPassFrame, publishDrawPassFrame, withDrawPass } from "./draw-passes";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import {
  copyOverlayBatchStats, countOverlayBatches, emptyOverlayBatchStats, sceneImagePages, setSceneDrawBatching, setSceneImagePages,
} from "./overlay-draw-batcher";
import { managedRenderReservations } from "./managed-render-resources";
import { OverlayLayoutRenderer } from "./overlay-layout-render";
import { applyOverlayUnlitMaterial } from "./overlay-texture-quad";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { buildSceneLayerHud } from "./scene-layer-hud-fixture";
import { createSpriteQuad, setSpriteQuadSize, setSpriteQuadUvs } from "./sprite-quad";
import { compileMaterialPlan } from "./material-compiler";
import { bindTextMaterialGlyph, textMaterialGlyphBinding, type TextMaterialBinding } from "./text-material-block";
import { setUnlitMaterial } from "./unlit-material";
import { unlitBinding } from "./unlit-material-blocks";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/**
 * A Play compositor with one Scene Layer, on a NullEngine whose draws count as WebGL2's do (one per draw call). With
 * `webgl2` it also reads texels by index as WebGL2 does, which the layer's shared page of small images needs.
 */
function host(options: { webgl2?: boolean } = {}) {
  const engine = adaptNullEngineFrameGraph(new NullEngine({
    renderWidth: 1280, renderHeight: 720, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1,
  }));
  engines.push(engine);
  if (options.webgl2) Object.defineProperty(engine, "webGLVersion", { get: () => 2 });
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

/** A square image as the resource cache loads a layer's: nearest, without mips, with alpha, repeating. */
function layerImage(scene: Scene, edge: number): RawTexture {
  const texture = RawTexture.CreateRGBATexture(new Uint8Array(edge * edge * 4).fill(255), edge, edge, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
  texture.hasAlpha = true;
  // A raw texture clamps where a loaded one repeats.
  texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

/** Each member's texel grid as a batch carries it, by where the member stands (the translation its world rows end in). */
function batchGrids(mesh: Mesh): Record<string, number[]> {
  const at = (kind: string, vertex: number) => Array.from(mesh.getVerticesData(kind)!.slice(vertex * 4, vertex * 4 + 4));
  const grids = new Map<number, number[]>();
  for (let vertex = 0; vertex < mesh.subMeshes[0]!.verticesCount; vertex += 1) {
    const x = at("batchWorld0", vertex)[3]!, grid = at("batchTexel", vertex);
    // Every vertex of a member carries the member's grid.
    expect(grids.get(x) ?? grid).toEqual(grid);
    grids.set(x, grid);
  }
  return Object.fromEntries(grids);
}

/**
 * An authored unlit, translucent Material compiled for a Scene Layer, as a Feature Test panel's is; `edit` changes its
 * document first.
 */
async function authoredOverlay(scene: Scene, edit: (document: MaterialDocument) => void = () => {}): Promise<NodeMaterial> {
  const document = createDefaultMaterialDocument();
  document.shadingModel = "unlit";
  document.blendMode = "translucent";
  edit(document);
  const lowered = lowerMaterialDocument(document);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const result = compileMaterialPlan(lowered.plan, { scene, name: "authored", overlay: true });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(await result.ready).toEqual([]);
  return result.material;
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
    // Blended, back to front: a (farthest), b, c. a and c bind the same; b draws at another visibility.
    const context = host();
    quad(context.scene, "a", 0, 0, { z: 0.9 });
    const b = quad(context.scene, "b", 0.6, 0, { z: 0.5 });
    b.visibility = 0.5;
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

  it("shares a draw between draws that differ only in colour, alpha and tint, which go with their vertices", async () => {
    const context = host();
    const { engine, compositor, scene } = context;
    const key = { textured: false, backFaceCulling: false, fog: true, role: "world" } as const;
    const quads = [-6, -3, 0, 3, 6].map((x, index) => quad(scene, `q${index}`, x, 0));
    applyOverlayVisualStyle(quads[1]!, { tint: [0.2, 0.3, 0.5, 0.6], opacity: 0.5 });
    setUnlitMaterial(quads[3]!, key, { texture: null, color: [1, 0.5, 0.25], alpha: 0.75, cutoff: 0, blend: false, textureAlpha: false, twoSided: false });
    expect(await drawsBothWays(context)).toEqual({ batched: 1, unbatched: 5 });
    // Each vertex carries what its member's own draw binds: its colour with its alpha, and its tint, whose alpha is
    // multiplied by the opacity. Read by where the member stands (the translation its world rows end in).
    setSceneDrawBatching(scene, true);
    const batch = drawnMeshes(() => layerDraws(engine, compositor, 1))[0]!;
    const at = (kind: string, vertex: number) => Array.from(batch.getVerticesData(kind)!.slice(vertex * 4, vertex * 4 + 4));
    const styles = new Map<number, { color: number[]; tint: number[] }>();
    for (let vertex = 0; vertex < 20; vertex += 1) styles.set(at("batchWorld0", vertex)[3]!, { color: at("batchColor", vertex), tint: at("batchTint", vertex) });
    const rounded = (values: number[]) => values.map(Math.fround);
    const plain = { color: [1, 1, 1, 1], tint: rounded([0.2, 0.3, 0.5, 0.8]) };
    expect(Object.fromEntries(styles)).toEqual({
      "-6": plain, "0": plain, "6": plain,
      // 0.6 × 0.5 opacity.
      "-3": { color: [1, 1, 1, 1], tint: rounded([0.2, 0.3, 0.5, 0.3]) },
      "3": { color: [1, 0.5, 0.25, 0.75], tint: plain.tint },
    });
    // What a draw binds once for all its vertices still tells draws apart: visibility, and the binding's alpha rules.
    quads[2]!.visibility = 0.5;
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 5 });
    setUnlitMaterial(quads[4]!, key, { texture: null, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: true });
    expect(await drawsBothWays(context)).toEqual({ batched: 3, unbatched: 5 });
  });

  it("uploads only the buffers whose contents changed: a move the world matrices, a tint the styles", async () => {
    const { engine, compositor, scene } = host();
    const moving = quad(scene, "moving", -2, 0);
    const tinted = quad(scene, "tinted", 2, 0);
    await compositor.prepare("hud", () => {});
    const batch = drawnMeshes(() => layerDraws(engine, compositor, 1))[0]!;
    const buffers = new Map<unknown, string>([["position", "position"], ["batchWorld0", "world"], ["batchColor", "style"]]
      .map(([kind, name]) => [batch.getVertexBuffer(kind!)!.getBuffer(), name!] as const));
    const vertexWrites = vi.spyOn(engine, "updateDynamicVertexBuffer");
    const indexWrites = vi.spyOn(engine, "updateDynamicIndexBuffer");
    const written = () => {
      layerDraws(engine, compositor, 1);
      const names = [...vertexWrites.mock.calls.map(([buffer]) => buffers.get(buffer) ?? "other"), ...indexWrites.mock.calls.map(() => "indices")];
      vertexWrites.mockClear();
      indexWrites.mockClear();
      return names;
    };
    // Nothing changed: nothing uploads.
    expect(written()).toEqual([]);
    moving.position.x = -3;
    expect(written()).toEqual(["world"]);
    applyOverlayVisualStyle(tinted, { tint: [1, 0, 0, 0.8] });
    expect(written()).toEqual(["style"]);
    // Every vertex and index of the batch is still the same member's: the tint's and the move's buffers alone.
    moving.position.y = 1;
    applyOverlayVisualStyle(moving, { tint: [0, 1, 0, 0.8] });
    expect(written().sort()).toEqual(["style", "world"]);
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
    // One at another visibility: batchable, but nothing draws the same.
    quad(scene, "faint", 3, 0).visibility = 0.5;
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

  it("batches an authored Scene Layer Material's draws, each with its own pose, tint and vertex data", async () => {
    const context = host();
    const { engine, compositor, scene } = context;
    const material = await authoredOverlay(scene);
    const panel = (name: string, x: number, tint: [number, number, number, number]) => {
      const mesh = MeshBuilder.CreatePlane(name, { size: 1 }, scene);
      mesh.material = material;
      mesh.position.x = x;
      applyOverlayVisualStyle(mesh, { tint });
      return mesh;
    };
    const panels = [panel("red", -6, [1, 0, 0, 0.5]), panel("green", -3, [0, 1, 0, 0.5]), panel("blue", 0, [0, 0, 1, 0.5]), panel("grey", 3, [0.5, 0.5, 0.5, 0.25])];
    panels[1]!.rotation.z = 0.3;
    // Stretched, as a panel sized to its content is: its normals then transform by the inverse transpose, in a program
    // of its own, which the batch's mesh must compile too.
    for (const mesh of panels) mesh.scaling.set(2, 0.5, 1);
    expect(await drawsBothWays(context)).toEqual({ batched: 1, unbatched: 4 });
    setSceneDrawBatching(scene, true);
    const stats = emptyOverlayBatchStats();
    const batch = countOverlayBatches(stats, () => drawnMeshes(() => layerDraws(engine, compositor, 1)))[0]!;
    expect(stats).toMatchObject({ visuals: 4, draws: 1, batches: 1, batched: 4 });
    expect(batch.material).toBe(material);
    // A graph may read what the unlit Material does not: the batch carries each member's normals and UVs with its
    // positions, as its own buffers hold them. A plane's normals face -z.
    const count = 16;
    expect(Array.from(batch.getVerticesData("normal")!.slice(0, count * 3))).toEqual(Array.from({ length: count }, () => [0, 0, -1]).flat());
    expect(Array.from(batch.getVerticesData("uv")!.slice(0, 8))).toEqual(Array.from(panels[0]!.getVerticesData("uv")!));
    // Each vertex's tint is its member's, by where the member stands.
    const at = (kind: string, vertex: number) => Array.from(batch.getVerticesData(kind)!.slice(vertex * 4, vertex * 4 + 4));
    const tints = new Map<number, number[]>();
    for (let vertex = 0; vertex < count; vertex += 1) tints.set(at("batchWorld0", vertex)[3]!, at("batchTint", vertex));
    expect(Object.fromEntries(tints)).toEqual({ "-6": [1, 0, 0, 0.5], "-3": [0, 1, 0, 0.5], "0": [0, 0, 1, 0.5], "3": [0.5, 0.5, 0.5, 0.25] });
    // Receive Shadows is bound once for a draw: members that differ in it draw apart, and a batch binds its members'.
    panels[3]!.receiveShadows = true;
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 4 });
    for (const mesh of panels) mesh.receiveShadows = true;
    setSceneDrawBatching(scene, true);
    await compositor.prepare("hud", () => {});
    const receiving = drawnMeshes(() => layerDraws(engine, compositor, 1));
    expect(receiving.map((mesh) => mesh.receiveShadows)).toEqual([true]);
    for (const mesh of panels) mesh.receiveShadows = false;
    // One program draws a Material's meshes however they are scaled: one scaled evenly shares the stretched rest's draw.
    panels[3]!.scaling.setAll(2);
    expect(await drawsBothWays(context)).toEqual({ batched: 1, unbatched: 4 });
    panels[3]!.scaling.set(2, 0.5, 1);
    // A Material that is not a Scene Layer's authored one draws each mesh on its own, as before.
    const standard = new StandardMaterial("standard", scene);
    standard.alpha = 0.5;
    panels[0]!.material = standard;
    panels[2]!.material = standard;
    setSceneDrawBatching(scene, true);
    await compositor.prepare("hud", () => {});
    const mixed = emptyOverlayBatchStats();
    countOverlayBatches(mixed, () => layerDraws(engine, compositor, 1));
    expect(mixed).toMatchObject({ visuals: 4, draws: 3, batches: 1, batched: 2, alone: { material: 2 } });
  });

  it("orders batches around an authored draw it cannot batch by where that draw is", async () => {
    // Blended, back to front: a (farthest), a mirror's panel, c. a and c draw the same; the panel's Material binds its
    // mesh's own reflection, so it joins no batch, but its stock vertex stage keeps it inside its bounds.
    const context = host();
    const { scene } = context;
    quad(scene, "a", 0, 0, { z: 0.9 });
    const mirror = MeshBuilder.CreatePlane("mirror", { size: 1 }, scene);
    mirror.material = await authoredOverlay(scene, (document) => {
      document.nodes.push({ id: "reflection", type: "input.mirrorReflection", position: { x: 0, y: 0 }, properties: {} });
      document.edges = [{ id: "reflection-output", sourceNodeId: "reflection", sourcePinId: "color", targetNodeId: "output", targetPinId: "baseColor" }];
    });
    // Off to the side, and 10.49 from the layer camera at (0, 0, -10): between a (10.9) and c (10.17) in the order.
    mirror.position.set(4, 0, -0.3);
    quad(scene, "c", 1.2, 0, { z: 0.1 });
    // The panel overlaps neither: c joins a across it.
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 3 });
    // Over c (10.61 from the camera), the panel must draw before it: c cannot join a, which draws before the panel.
    mirror.position.set(1.5, 0, 0.5);
    expect(await drawsBothWays(context)).toEqual({ batched: 3, unbatched: 3 });
    // A Material that moves vertices in its vertex stage may draw anywhere: every draw after it stays after it.
    mirror.position.set(4, 0, -0.3);
    mirror.material = await authoredOverlay(scene, (document) => {
      document.nodes.find((node) => node.type === "output.surface")!.properties = { "default:worldPositionOffset": [0, 1, 0] };
    });
    expect(await drawsBothWays(context)).toEqual({ batched: 3, unbatched: 3 });
  });

  it("batches the glyphs of a text that draws an authored Text Material, each with its own rectangles, colour and visibility", async () => {
    const context = host();
    const { engine, compositor, scene } = context;
    const document = createDefaultMaterialDocument("text", "text");
    const lowered = lowerMaterialDocument(document);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "authoredText", overlay: true });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(await compiled.ready).toEqual([]);
    const atlas = RawTexture.CreateRGBATexture(new Uint8Array(64 * 64 * 4).fill(255), 64, 64, scene);
    const glyph = (name: string, x: number, atlasRect: [number, number, number, number], color: [number, number, number], changes: Partial<TextMaterialBinding> = {}) => {
      const mesh = MeshBuilder.CreatePlane(name, { size: 1 }, scene);
      mesh.material = compiled.material;
      mesh.position.x = x;
      bindTextMaterialGlyph(mesh, { atlas, mode: "bitmap", color, outlineColor: [0, 0, 0], outline: 0, atlasRect, materialRect: [x, 0, 1, 2], ...changes });
      return mesh;
    };
    const glyphs = [glyph("g0", -3, [0, 0, 0.25, 0.5], [1, 0, 0]), glyph("g1", 0, [0.25, 0, 0.25, 0.5], [0, 1, 0]), glyph("g2", 3, [0.5, 0.5, 0.125, 0.25], [0, 0, 1])];
    // A glyph half revealed: its visibility goes with its vertices too.
    glyphs[1]!.visibility = 0.5;
    expect(await drawsBothWays(context)).toEqual({ batched: 1, unbatched: 3 });
    setSceneDrawBatching(scene, true);
    const batch = drawnMeshes(() => layerDraws(engine, compositor, 1))[0]!;
    // The batch binds what its glyphs share (their atlas, mode and outline) as its first glyph does.
    expect(textMaterialGlyphBinding(batch)?.atlas).toBe(atlas);
    const at = (kind: string, vertex: number) => Array.from(batch.getVerticesData(kind)!.slice(vertex * 4, vertex * 4 + 4));
    const carried = new Map<number, number[][]>();
    for (let vertex = 0; vertex < 12; vertex += 1)
      carried.set(at("batchWorld0", vertex)[3]!, [at("batchTextAtlasRect", vertex), at("batchTextMaterialRect", vertex), at("batchTextTint", vertex)]);
    expect(Object.fromEntries(carried)).toEqual({
      "-3": [[0, 0, 0.25, 0.5], [-3, 0, 1, 2], [1, 0, 0, 1]],
      "0": [[0.25, 0, 0.25, 0.5], [0, 0, 1, 2], [0, 1, 0, 0.5]],
      "3": [[0.5, 0.5, 0.125, 0.25], [3, 0, 1, 2], [0, 0, 1, 1]],
    });
    // What a text binds once for a draw tells glyphs apart: another outline, mode or atlas.
    bindTextMaterialGlyph(glyphs[2]!, { ...textMaterialGlyphBinding(glyphs[2]!)!, outline: 1 });
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 3 });
    bindTextMaterialGlyph(glyphs[2]!, { ...textMaterialGlyphBinding(glyphs[2]!)!, outline: 0, mode: "msdf" });
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 3 });
    bindTextMaterialGlyph(glyphs[2]!, { ...textMaterialGlyphBinding(glyphs[2]!)!, mode: "bitmap", outlineColor: [1, 1, 1] });
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 3 });
    const other = RawTexture.CreateRGBATexture(new Uint8Array(64 * 64 * 4).fill(255), 64, 64, scene);
    bindTextMaterialGlyph(glyphs[2]!, { ...textMaterialGlyphBinding(glyphs[2]!)!, outlineColor: [0, 0, 0], atlas: other });
    expect(await drawsBothWays(context)).toEqual({ batched: 2, unbatched: 3 });
    // A mesh that draws the text's Material without a glyph's binding has nothing a batch could carry for it.
    const bare = MeshBuilder.CreatePlane("bare", { size: 1 }, scene);
    bare.material = compiled.material;
    bare.position.set(0, 3, 0);
    setSceneDrawBatching(scene, true);
    await compositor.prepare("hud", () => {});
    const stats = emptyOverlayBatchStats();
    countOverlayBatches(stats, () => layerDraws(engine, compositor, 1));
    expect(stats).toMatchObject({ visuals: 4, batched: 2, alone: { other: 1, unmatched: 1 } });
    // The batch mesh that drew glyphs then draws other visuals without the glyphs' vertex data.
    const glyphBatch = drawnMeshes(() => layerDraws(engine, compositor, 1)).find((mesh) => mesh.name.startsWith("drawBatch"))!;
    expect(glyphBatch.isVerticesDataPresent("batchTextTint")).toBe(true);
    for (const mesh of [...glyphs, bare]) mesh.setEnabled(false);
    quad(scene, "a", -2, 0);
    quad(scene, "b", 2, 0);
    await compositor.prepare("hud", () => {});
    layerDraws(engine, compositor);
    expect(drawnMeshes(() => layerDraws(engine, compositor, 1))).toEqual([glyphBatch]);
    expect(["batchTextAtlasRect", "batchTextMaterialRect", "batchTextTint"].map((kind) => glyphBatch.isVerticesDataPresent(kind))).toEqual([false, false, false]);
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
    // The unevenly scaled cards' and the turned widgets' unlit visuals batch with the rest, as do texts of different
    // colours: each visual carries its own pose, colour and tint.
    expect({ batched, unbatched }).toEqual({ batched: 57, unbatched: 195 });
    // Batch meshes join no Scene list: nothing culls, picks, probes or counts them.
    expect(scene.meshes).toHaveLength(meshes);
    await compositor.dispose();
  });

  it("draws visuals of different small images in one draw, from the layer's shared page", async () => {
    const { engine, compositor, scene } = host({ webgl2: true });
    const edges = [16, 32, 8];
    const sprites = edges.map((edge, index) => sprite(scene, `sprite${index}`, -2 + index * 2, layerImage(scene, edge)));
    // One shows a frame of its image, as an animated sprite does.
    setSpriteQuadUvs(sprites[1]!, { u0: 0.5, v0: 0.25, u1: 0.75, v1: 0.5 });
    await compositor.prepare("hud", () => {});
    // The frame that first draws them asks for their cells, in its draw order: each still samples its own texture.
    const first = drawnMeshes(() => layerDraws(engine, compositor, 1));
    expect(new Set(first)).toEqual(new Set(sprites));
    expect(first).toHaveLength(3);
    expect(sceneImagePages(scene)).toEqual({ images: 3, drawn: 0 });
    // From the next frame on, one draw samples the page.
    const drawn = drawnMeshes(() => layerDraws(engine, compositor, 1));
    expect(drawn).toHaveLength(1);
    const batch = drawn[0]!;
    expect(sprites).not.toContain(batch);
    expect(unlitBinding(batch).texture!.name).toBe("layer-image-atlas:alpha");
    expect(sceneImagePages(scene)).toEqual({ images: 3, drawn: 3 });
    // Each member carries its image's size (negative: its texture repeats, as a loaded image's does) and where its
    // cell starts: cells sit side by side on the first shelf in the order asked for.
    const order = first.map((mesh) => sprites.indexOf(mesh));
    const starts = order.map((_sprite, index) => order.slice(0, index).reduce((sum, before) => sum + edges[before]!, 0));
    expect(batchGrids(batch)).toEqual(Object.fromEntries(order.map((index, place) => [String(-2 + index * 2), [-edges[index]!, -edges[index]!, starts[place]!, 0]])));
    // Its UVs are its own, a frame of its image included: the texel they fall in is found from them, as in its own draw.
    const uvs = new Map<number, number[]>();
    const all = batch.getVerticesData("uv")!, rows = batch.getVerticesData("batchWorld0")!;
    for (let vertex = 0; vertex < 12; vertex += 1) uvs.set(rows[vertex * 4 + 3]!, [...(uvs.get(rows[vertex * 4 + 3]!) ?? []), all[vertex * 2]!, all[vertex * 2 + 1]!]);
    expect(Object.fromEntries(uvs)).toEqual({ "-2": [0, 0, 1, 0, 1, 1, 0, 1], "0": [0.5, 0.25, 0.75, 0.25, 0.75, 0.5, 0.5, 0.5], "2": [0, 0, 1, 0, 1, 1, 0, 1] });
    // The members keep their own bindings: a draw of one alone is as it was.
    for (const mesh of sprites) expect(unlitBinding(mesh).texture!.name).not.toContain("layer-image-atlas");
    expect(layerDraws(engine, compositor)).toBe(1);
    await compositor.dispose();
  });

  it("carries each member's own texel grid in a batch of one texture, with no cell", async () => {
    const { engine, compositor, scene } = host();
    // No page here (the engine reads no texels by index): two sprites of one nearest image still share a draw.
    const texture = layerImage(scene, 32);
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    sprite(scene, "left", -2, texture);
    sprite(scene, "right", 2, texture);
    await compositor.prepare("hud", () => {});
    layerDraws(engine, compositor, 1);
    const drawn = drawnMeshes(() => layerDraws(engine, compositor, 1));
    expect(drawn).toHaveLength(1);
    expect(unlitBinding(drawn[0]!).texture).toBe(texture);
    // The image's size, positive where its texture clamps and negative where it repeats; it starts at the texture's origin.
    expect(batchGrids(drawn[0]!)).toEqual({ "-2": [32, -32, 0, 0], "2": [32, -32, 0, 0] });
    // A filtered texture has no grid: the sampler takes its lookups as they are.
    texture.updateSamplingMode(Texture.BILINEAR_SAMPLINGMODE);
    expect(batchGrids(drawnMeshes(() => layerDraws(engine, compositor, 1))[0]!)).toEqual({ "-2": [0, 0, 0, 0], "2": [0, 0, 0, 0] });
    await compositor.dispose();
  });

  it("keeps a visual on its own texture when a lookup on the page would not read what its own texture gives", async () => {
    const { engine, compositor, scene } = host({ webgl2: true });
    const names = ["plain", "tiled", "moved", "filtered", "mirrored", "other"];
    const sprites = names.map((name, index) => sprite(scene, name, -5 + index * 2, layerImage(scene, 16)));
    const [, tiled, moved, filtered, mirrored] = sprites as [Mesh, Mesh, Mesh, Mesh, Mesh, Mesh];
    // Repeats its image twice across: the texel is found within the image, as its own texture's sampler wraps it.
    setSpriteQuadUvs(tiled, { u0: 0, v0: 0, u1: 2, v1: 1 });
    // A texture offset moves every lookup, which the page's own matrix would not.
    (unlitBinding(moved).texture as Texture).uOffset = 0.25;
    // Filtered lookups blend neighbouring texels, a cell's neighbours on the page.
    (unlitBinding(filtered).texture as Texture).updateSamplingMode(Texture.BILINEAR_SAMPLINGMODE);
    // A mirrored repeat is the sampler's alone.
    unlitBinding(mirrored).texture!.wrapU = Texture.MIRROR_ADDRESSMODE;
    await compositor.prepare("hud", () => {});
    layerDraws(engine, compositor, 1);
    const drawn = drawnMeshes(() => layerDraws(engine, compositor, 1));
    // Three share the page, the tiled one among them; the others draw themselves, from their own textures.
    expect(drawn).toHaveLength(4);
    expect(drawn.filter((mesh) => sprites.includes(mesh)).map((mesh) => mesh.name).sort()).toEqual(["filtered", "mirrored", "moved"]);
    const batch = drawn.find((mesh) => !sprites.includes(mesh))!;
    expect(unlitBinding(batch).texture!.name).toBe("layer-image-atlas:alpha");
    expect(Object.keys(batchGrids(batch)).sort()).toEqual(["-3", "-5", "5"]);
    // The page holds the images that are drawn from it, and no other.
    expect(sceneImagePages(scene)).toEqual({ images: 3, drawn: 3 });
    await compositor.dispose();
  });

  it("does not share a draw between images whose textures differ in alpha", async () => {
    const { engine, compositor, scene } = host({ webgl2: true });
    const sprites = [0, 1, 2, 3].map((index) => sprite(scene, `sprite${index}`, -3 + index * 2, layerImage(scene, 16)));
    // The texture's alpha is bound with the texture: a draw has one value of it.
    for (const index of [1, 3]) unlitBinding(sprites[index]).texture!.hasAlpha = false;
    await compositor.prepare("hud", () => {});
    layerDraws(engine, compositor, 1);
    const drawn = drawnMeshes(() => layerDraws(engine, compositor, 1));
    expect(drawn.map((mesh) => unlitBinding(mesh).texture!.name).sort()).toEqual(["layer-image-atlas:alpha", "layer-image-atlas:opaque"]);
    expect(drawn.map((mesh) => Object.keys(batchGrids(mesh)).sort())).toEqual(
      drawn.map((mesh) => unlitBinding(mesh).texture!.hasAlpha ? ["-3", "1"] : ["-1", "3"]));
    await compositor.dispose();
  });

  it("draws each batch from its members' own textures while the shared page is off", async () => {
    const { engine, compositor, scene } = host({ webgl2: true });
    const sprites = [0, 1, 2].map((index) => sprite(scene, `sprite${index}`, -2 + index * 2, layerImage(scene, 16)));
    await compositor.prepare("hud", () => {});
    expect(layerDraws(engine, compositor)).toBe(1);
    setSceneImagePages(scene, false);
    expect(sceneImagePages(scene)).toEqual({ images: 0, drawn: 0 });
    const own = drawnMeshes(() => layerDraws(engine, compositor, 1));
    expect(new Set(own)).toEqual(new Set(sprites));
    expect(layerDraws(engine, compositor)).toBe(3);
    setSceneImagePages(scene, true);
    expect(layerDraws(engine, compositor)).toBe(1);
    await compositor.dispose();
  });

  it("binds a page batch's values as its first member binds them now, and gives the page back with the batcher", async () => {
    const { engine, compositor, scene } = host({ webgl2: true });
    const key = { textured: true, backFaceCulling: true, fog: true, role: "world" } as const;
    const before = managedRenderReservations(engine).reservedBytes;
    const sprites = [0, 1].map((index) => sprite(scene, `sprite${index}`, -2 + index * 4, layerImage(scene, 16)));
    await compositor.prepare("hud", () => {});
    layerDraws(engine, compositor, 1);
    const values = (mesh: Mesh) => ({ ...unlitBinding(mesh), texture: unlitBinding(mesh).texture!.name });
    const cutout = drawnMeshes(() => layerDraws(engine, compositor, 1));
    expect(cutout.map(values)).toEqual([
      { texture: "layer-image-atlas:alpha", color: [1, 1, 1], alpha: 1, cutoff: 0.4, blend: false, textureAlpha: true, twoSided: false },
    ]);
    // The sprites now blend, read no alpha from their textures and show both sides: the same batch mesh draws them so.
    for (const mesh of sprites)
      setUnlitMaterial(mesh, key, { texture: unlitBinding(mesh).texture, color: [1, 0.5, 0.25], alpha: 0.5, cutoff: 0, blend: true, textureAlpha: false, twoSided: true });
    const blended = drawnMeshes(() => layerDraws(engine, compositor, 1));
    expect(blended).toEqual(cutout);
    expect(blended.map(values)).toEqual([
      { texture: "layer-image-atlas:alpha", color: [1, 0.5, 0.25], alpha: 0.5, cutoff: 0, blend: true, textureAlpha: false, twoSided: true },
    ]);
    // The page is the batcher's: 512 × 512 texels of four bytes on the ledger while it batches.
    expect(managedRenderReservations(engine).reservedBytes - before).toBe(512 * 512 * 4);
    setSceneDrawBatching(scene, false);
    await Promise.resolve();
    expect(managedRenderReservations(engine).reservedBytes).toBe(before);
    await compositor.dispose();
  });

  it("draws the Feature Test HUD in fewer draws when its icons share a page", async () => {
    const { engine, compositor, scene } = host({ webgl2: true });
    const textures = new Map<string, RawTexture>();
    buildSceneLayerHud(scene, {
      texture: (guid) => {
        let found = textures.get(guid);
        if (!found) textures.set(guid, (found = layerImage(scene, 64)));
        return found;
      },
    });
    await compositor.prepare("hud", () => {});
    const shared = layerDraws(engine, compositor);
    expect(sceneImagePages(scene)).toEqual({ images: 7, drawn: 7 });
    setSceneImagePages(scene, false);
    const own = layerDraws(engine, compositor);
    // The row of turned widgets draws its seven icons in one draw in place of seven, as far as draw order allows.
    expect({ shared, own }).toEqual({ shared: 26, own: 32 });
    await compositor.dispose();
  });
});

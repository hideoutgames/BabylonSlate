import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sceneDrawBatcher } from "./draw-batching";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { layerDrawListWork, verifyLayerDrawLists } from "./layer-draw-list";
import { setSceneDrawBatching } from "./overlay-draw-batcher";
import { applyOverlayUnlitMaterial } from "./overlay-texture-quad";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import { SceneLayerCompositor } from "./scene-layer-compositor";
import { layerCanvas } from "./scene-layer-canvas-fixtures";

const engines: NullEngine[] = [];
afterEach(() => {
  verifyLayerDrawLists(false);
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A Play compositor with one Scene Layer, its camera 10 units in front of the origin, looking along +Z. */
async function layer(build: (scene: Scene) => void) {
  const engine = adaptNullEngineFrameGraph(new NullEngine({
    renderWidth: 1280, renderHeight: 720, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1,
  }));
  engines.push(engine);
  const compositor = new SceneLayerCompositor({ engine });
  const { scene } = compositor.create({ type: "sceneLayerCreate", layerId: "hud", assetGuid: "hud", zOrder: 0, ownerSceneGuid: null, postProcessStack: [], canvas: layerCanvas(32, 18) });
  build(scene);
  await compositor.prepare("hud", () => {});
  /** The lists the layer's batcher is handed in each of `count` frames: the last frame's, by mesh name. */
  const handed: Array<{ transparent: boolean; names: string[] }> = [];
  const batcher = sceneDrawBatcher(scene)!;
  const draw = batcher.draw.bind(batcher);
  batcher.draw = (sorted: readonly SubMesh[], count: number, transparent: boolean, drawOne: (subMesh: SubMesh) => void) => {
    handed.push({ transparent, names: sorted.slice(0, count).map((subMesh) => subMesh.getMesh().name) });
    draw(sorted, count, transparent, drawOne);
  };
  const frames = (count = 1) => {
    for (let index = 0; index < count; index += 1) {
      handed.length = 0;
      engine.beginFrame();
      try { compositor.render(); } finally { engine.endFrame(); }
    }
    return handed.map((list) => ({ ...list, names: [...list.names] }));
  };
  // Past the first full read, so the next frames draw from the retained lists.
  frames(2);
  return { engine, compositor, scene, frames, work: () => layerDrawListWork(scene)! };
}

/** A unit quad of the overlay unlit Material at (x, y, z), blended by its tint's alpha unless `opaque`. */
function quad(scene: Scene, name: string, x: number, z = 0, options: { opaque?: boolean; y?: number } = {}): Mesh {
  const mesh = MeshBuilder.CreatePlane(name, { size: 1 }, scene);
  applyOverlayUnlitMaterial(mesh);
  mesh.position.set(x, options.y ?? 0, z);
  applyOverlayVisualStyle(mesh, { tint: [0.2, 0.3, 0.5, options.opaque ? 1 : 0.8] });
  return mesh;
}

/** The blended list the last frame handed the batcher, by mesh name. */
function blended(lists: Array<{ transparent: boolean; names: string[] }>): string[] {
  return lists.filter((list) => list.transparent).flatMap((list) => list.names);
}

/** Each member's world translation along X as the batches drawn last frame carry it (their world rows), sorted. */
function batchedX(scene: Scene): number[] {
  const xs = new Set<number>();
  for (const mesh of sceneDrawBatcher(scene)!.outputs()) {
    // Each vertex's first world row (four floats, the last its translation), for the vertices in use: the buffers keep spare room.
    const rows = (mesh as Mesh).getVerticesData("batchWorld0");
    if (!rows) continue;
    const used = (mesh as Mesh).subMeshes[0]!.verticesCount * 4;
    for (let at = 3; at < used; at += 4) xs.add(Math.round(rows[at]! * 1000) / 1000);
  }
  return [...xs].sort((a, b) => a - b);
}

describe("layer draw list", () => {
  it("hands the batcher Babylon's back-to-front order while Babylon reads only the meshes the batcher draws", async () => {
    // Distances to the camera at (0, 0, -10): q0 10.44, q1 12, q2 11.40.
    const { scene, frames, work } = await layer((scene) => {
      quad(scene, "q0", -3, 0);
      quad(scene, "q1", 0, 2);
      quad(scene, "q2", 3, 1);
    });
    const candidates: string[][] = [];
    const loop = scene.getActiveMeshCandidates;
    scene.getActiveMeshCandidates = () => {
      const listed = loop.call(scene);
      candidates.push((listed.data as AbstractMesh[]).slice(0, listed.length).map((mesh) => mesh.name));
      return listed;
    };
    const asked: string[] = [];
    const isReady = Mesh.prototype.isReady;
    vi.spyOn(Mesh.prototype, "isReady").mockImplementation(function (this: Mesh, ...args) {
      asked.push(this.name);
      return isReady.apply(this, args);
    });
    const retained = work().retainedFrames;
    expect(blended(frames())).toEqual(["q1", "q2", "q0"]);
    expect(work().retainedFrames).toBe(retained + 1);
    // The mesh loop walked the one batch mesh the batcher drew last frame, and no visual was asked whether it is ready.
    expect(candidates).toEqual([["drawBatch:0"]]);
    expect(asked.filter((name) => name.startsWith("q"))).toEqual([]);
  });

  it("follows each kind of change, and members whose moves cross each other", async () => {
    const meshes: Record<string, Mesh> = {};
    const { scene, frames, work, compositor } = await layer((scene) => {
      meshes.q0 = quad(scene, "q0", -3, 0);
      meshes.q1 = quad(scene, "q1", 0, 2);
      meshes.q2 = quad(scene, "q2", 3, 1);
    });
    const { q0, q1, q2 } = meshes as Record<"q0" | "q1" | "q2", Mesh>;
    // A move that crosses both others (q0 13.34): it draws first.
    q0.position.z = 3;
    expect(blended(frames())).toEqual(["q0", "q1", "q2"]);
    // A move that keeps every place.
    q0.position.z = 2.9;
    expect(blended(frames())).toEqual(["q0", "q1", "q2"]);
    // A lower alphaIndex sorts first whatever the distance (no write point notes it: polled).
    q2.alphaIndex = 0;
    expect(blended(frames())).toEqual(["q2", "q0", "q1"]);
    q2.alphaIndex = Number.MAX_VALUE;
    expect(blended(frames())).toEqual(["q0", "q1", "q2"]);
    // Hidden, disabled, faded out, then back.
    q1.isVisible = false;
    expect(blended(frames())).toEqual(["q0", "q2"]);
    q1.isVisible = true;
    q2.setEnabled(false);
    expect(blended(frames())).toEqual(["q0", "q1"]);
    q2.setEnabled(true);
    q1.visibility = 0;
    expect(blended(frames())).toEqual(["q0", "q2"]);
    q1.visibility = 1;
    expect(blended(frames())).toEqual(["q0", "q1", "q2"]);
    // A style that turns opaque moves it to the opaque list.
    applyOverlayVisualStyle(q1, { tint: [0.2, 0.3, 0.5, 1] });
    const lists = frames();
    expect(blended(lists)).toEqual(["q0", "q2"]);
    expect(lists.filter((list) => !list.transparent).flatMap((list) => list.names)).toEqual(["q1"]);
    // Added and removed at runtime: q3 at (0, 0, 5), 15 away, draws first.
    quad(scene, "q3", 0, 5);
    expect(blended(frames())).toEqual(["q3", "q0", "q2"]);
    q0.dispose();
    expect(blended(frames())).toEqual(["q3", "q2"]);
    // A camera panned away frames nothing; back, the same lists.
    compositor.setCamera("hud", { x: 100, y: 0, rotation: 0, zoom: 1 });
    expect(blended(frames())).toEqual([]);
    compositor.setCamera("hud", { x: 0, y: 0, rotation: 0, zoom: 1 });
    expect(blended(frames())).toEqual(["q3", "q2"]);
    expect(work()).toMatchObject({ fallbackFrames: 0, heals: 0, mismatches: 0 });
  });

  it("recomputes exactly what moved, whoever wrote the pose, before the batches read it", async () => {
    const meshes: Record<string, Mesh> = {};
    const { scene, frames } = await layer((scene) => {
      // An actor root draws nothing and is hidden: the drawable list leaves it out, its children move with it.
      const root = meshes.root = new Mesh("actor-1", scene);
      root.isVisible = false;
      meshes.other = new Mesh("actor-2", scene);
      meshes.other.isVisible = false;
      meshes.other.position.x = 10;
      for (const [name, x] of [["a", -2], ["b", 2]] as const) {
        const mesh = meshes[name] = quad(scene, name, x);
        mesh.parent = root;
      }
    });
    const { root, other, a, b } = meshes as Record<"root" | "other" | "a" | "b", Mesh>;
    expect(batchedX(scene)).toEqual([-2, 2]);
    // A hidden ancestor written in place.
    root.position.x = 1;
    frames();
    expect(batchedX(scene)).toEqual([-1, 3]);
    // A replaced vector.
    a.position = new Vector3(-4, 0, 0);
    frames();
    expect(batchedX(scene)).toEqual([-3, 3]);
    // A scaled ancestor.
    root.scaling.x = 2;
    frames();
    expect(batchedX(scene)).toEqual([-7, 5]);
    // Re-parented under an actor at x 10.
    b.parent = other;
    frames();
    expect(batchedX(scene)).toEqual([-7, 12]);
  });

  it("takes Babylon's full path for a frame it cannot represent, and counts why", async () => {
    let q0!: Mesh;
    const { scene, frames, work } = await layer((scene) => {
      q0 = quad(scene, "q0", -3, 0);
      quad(scene, "q1", 0, 2);
    });
    // A level of detail is chosen per frame by Babylon's preparation.
    q0.addLODLevel(1000, null);
    expect(blended(frames(2))).toEqual(["q1", "q0"]);
    expect(work().fallbacks).toEqual({ lod: 2 });
    q0.removeLODLevel(null);
    const retained = work().retainedFrames;
    expect(blended(frames())).toEqual(["q1", "q0"]);
    expect(work().retainedFrames).toBe(retained + 1);
    // Without a batcher (the batching proof turns it off) the list draws nothing.
    setSceneDrawBatching(scene, false);
    frames();
    expect(work().fallbacks).toEqual({ lod: 2, batcher: 1 });
  });

  it("heals a change nothing heard at its next periodic check, and counts it", async () => {
    let q0!: Mesh;
    const { frames, work } = await layer((scene) => {
      q0 = quad(scene, "q0", -3, 0);
      quad(scene, "q1", 0, 2);
    });
    // Bounds replaced without a pose or geometry change: the cull would now leave it out.
    q0.getBoundingInfo().reConstruct(new Vector3(500, 500, 0), new Vector3(501, 501, 0), q0.getWorldMatrix());
    expect(blended(frames())).toEqual(["q1", "q0"]);
    frames(32);
    expect(work()).toMatchObject({ heals: 1, mismatches: 0 });
    expect(work().mismatchDetails).toEqual(["group 0 blended: Babylon 1, retained 2, first difference at 1 (none / q0)"]);
    expect(blended(frames())).toEqual(["q1"]);
  });

  it("checks every fourth frame against Babylon's while verifying, and counts a difference as a mismatch", async () => {
    let q0!: Mesh;
    const { frames, work } = await layer((scene) => {
      q0 = quad(scene, "q0", -3, 0);
      quad(scene, "q1", 0, 2);
      quad(scene, "q2", 3, 1, { opaque: true });
    });
    verifyLayerDrawLists(true);
    const checked = work().checkedFrames;
    frames(8);
    expect(work()).toMatchObject({ checkedFrames: checked + 2, mismatches: 0 });
    q0.getBoundingInfo().reConstruct(new Vector3(500, 500, 0), new Vector3(501, 501, 0), q0.getWorldMatrix());
    frames(4);
    expect(work()).toMatchObject({ mismatches: 1, heals: 0 });
  });
});

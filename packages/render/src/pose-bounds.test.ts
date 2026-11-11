import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { BakedVertexAnimationManager } from "@babylonjs/core/BakedVertexAnimation/bakedVertexAnimationManager";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLatticeBinding } from "./lattice-deformer-binding";
import { followPose, followsPose, setScenePoseBounds, updatePoseBounds } from "./pose-bounds";
import { skinnedRig as rig, skinnedStrip as strip } from "./skinned-test-fixtures";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

function host() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  /** One Engine frame's bounds, as the frame's first cull asks for them. */
  const frame = () => {
    engine.beginFrame();
    updatePoseBounds(scene);
    engine.endFrame();
  };
  return { engine, scene, frame };
}

/** The mesh's bounding box in the world, to two decimals (the box is a ten-thousandth of its size wider than the pose). */
function box(mesh: AbstractMesh): { min: number[]; max: number[] } {
  const { minimumWorld, maximumWorld } = mesh.getBoundingInfo().boundingBox;
  const round = (value: number) => Math.round(value * 100) / 100 + 0;
  return { min: minimumWorld.asArray().map(round), max: maximumWorld.asArray().map(round) };
}

describe("pose bounds", () => {
  it("keeps a skinned mesh's bounds around its pose, wherever its bones take its vertices", () => {
    const { scene, frame } = host();
    const { skeleton, root, arm } = rig(scene);
    const mesh = strip(scene, skeleton);
    expect(followsPose(mesh)).toBe(false);
    expect(followPose(mesh)).toBe(true);
    expect(followsPose(mesh)).toBe(true);
    frame();
    // As bound: the strip as authored.
    expect(box(mesh)).toEqual({ min: [0, 0, 0], max: [1, 2, 0] });
    // The arm goes five units along x: its edge is at x = 5..6, the root's stays.
    arm.position = new Vector3(5, 2, 0);
    frame();
    expect(box(mesh)).toEqual({ min: [0, 0, 0], max: [6, 2, 0] });
    // The root carries both edges ten units down; the arm keeps its offset from it.
    root.position = new Vector3(0, -10, 0);
    frame();
    expect(box(mesh)).toEqual({ min: [0, -10, 0], max: [6, -8, 0] });
    // The mesh's own place is applied to the posed box, as to any mesh's.
    mesh.position.x = 100;
    mesh.computeWorldMatrix(true);
    expect(box(mesh)).toEqual({ min: [100, -10, 0], max: [106, -8, 0] });
    // Asking again follows it no second time.
    const observers = skeleton.onBeforeComputeObservable.observers.length;
    expect(followPose(mesh)).toBe(true);
    expect(skeleton.onBeforeComputeObservable.observers.length).toBe(observers);
  });

  it("takes a frame's pose once, at the frame's first cull, and leaves a mesh whose skeleton did not move", () => {
    const { engine, scene, frame } = host();
    const { skeleton, arm } = rig(scene);
    const mesh = strip(scene, skeleton);
    followPose(mesh);
    frame();
    const rebuilt = vi.spyOn(mesh.getBoundingInfo(), "reConstruct");
    // Nothing moved: nothing is written.
    frame();
    expect(rebuilt).not.toHaveBeenCalled();
    arm.position = new Vector3(5, 2, 0);
    engine.beginFrame();
    updatePoseBounds(scene);
    expect(rebuilt).toHaveBeenCalledTimes(1);
    // A second cull of the same frame finds the bounds as the first left them, even if a bone moved since.
    arm.position = new Vector3(9, 2, 0);
    updatePoseBounds(scene);
    engine.endFrame();
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect(box(mesh).max).toEqual([6, 2, 0]);
    frame();
    expect(box(mesh).max).toEqual([10, 2, 0]);
  });

  it("does not follow a mesh something else poses, or whose vertices it cannot read", () => {
    const { scene } = host();
    const { skeleton } = rig(scene);
    const refused: Record<string, Mesh> = {
      "no skeleton": (() => { const mesh = strip(scene, skeleton, "plain"); mesh.skeleton = null; return mesh; })(),
      "morph targets": (() => { const mesh = strip(scene, skeleton, "morph"); mesh.morphTargetManager = new MorphTargetManager(scene); return mesh; })(),
      "a baked vertex animation": (() => { const mesh = strip(scene, skeleton, "baked"); mesh.bakedVertexAnimationManager = new BakedVertexAnimationManager(scene); return mesh; })(),
      "a lattice": (() => { const mesh = strip(scene, skeleton, "lattice"); setLatticeBinding(mesh, { active: true } as Parameters<typeof setLatticeBinding>[1]); return mesh; })(),
      "skinned on the CPU": (() => { const mesh = strip(scene, skeleton, "cpu"); mesh.computeBonesUsingShaders = false; return mesh; })(),
      "positions its owner rewrites": (() => {
        const mesh = strip(scene, skeleton, "updatable");
        mesh.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0], true);
        return mesh;
      })(),
      "no weights": (() => { const mesh = strip(scene, skeleton, "unweighted"); mesh.removeVerticesData(VertexBuffer.MatricesWeightsKind); return mesh; })(),
      "more influences than it has sets for": (() => { const mesh = strip(scene, skeleton, "eight"); mesh.numBoneInfluencers = 8; return mesh; })(),
      "an index past its skeleton": (() => {
        const mesh = strip(scene, skeleton, "stray");
        mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 7, 0, 0, 0]);
        return mesh;
      })(),
    };
    expect(Object.fromEntries(Object.entries(refused).map(([name, mesh]) => [name, followPose(mesh)]))).toEqual(
      Object.fromEntries(Object.keys(refused).map((name) => [name, false])));
    // With its extra set, a mesh of eight influences is followed, and the extra set's bones count: here the arm moves
    // a vertex through the extra set alone (the first set gives every vertex to the root).
    const { skeleton: own, arm } = rig(scene);
    const eight = strip(scene, own, "eight sets");
    eight.numBoneInfluencers = 8;
    eight.setVerticesData(VertexBuffer.MatricesIndicesKind, new Array<number>(16).fill(0));
    eight.setVerticesData(VertexBuffer.MatricesWeightsKind, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0, 0, 0]);
    eight.setVerticesData(VertexBuffer.MatricesIndicesExtraKind, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    eight.setVerticesData(VertexBuffer.MatricesWeightsExtraKind, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0]);
    arm.position = new Vector3(9, 2, 0);
    expect(followPose(eight)).toBe(true);
    // Its last vertex, at (1, 2, 0), may be drawn anywhere up to where the arm alone would put it, nine units along x.
    expect(box(eight)).toEqual({ min: [0, 0, 0], max: [10, 2, 0] });
    // A Scene turned off follows none of its meshes, until it is turned on again.
    const off = host();
    const other = rig(off.scene);
    setScenePoseBounds(off.scene, false);
    const unfollowed = strip(off.scene, other.skeleton);
    expect(followPose(unfollowed)).toBe(false);
    expect(followsPose(unfollowed)).toBe(false);
    setScenePoseBounds(off.scene, true);
    expect(followPose(unfollowed)).toBe(true);
  });

  it("gives every submesh, and every instance at its own place, the mesh's posed bounds", () => {
    const { scene, frame } = host();
    const { skeleton, arm } = rig(scene);
    const mesh = strip(scene, skeleton);
    // Two submeshes, a triangle each: Babylon culls such a mesh by each one's bounds.
    mesh.subMeshes.length = 0;
    new SubMesh(0, 0, 4, 0, 3, mesh);
    new SubMesh(0, 0, 4, 3, 3, mesh);
    const instance = mesh.createInstance("instance");
    instance.position.z = 50;
    instance.computeWorldMatrix(true);
    expect(followPose(instance)).toBe(true);
    expect(followsPose(instance)).toBe(true);
    arm.position = new Vector3(5, 2, 0);
    frame();
    expect(box(mesh)).toEqual({ min: [0, 0, 0], max: [6, 2, 0] });
    for (const subMesh of mesh.subMeshes) expect(subMesh.getBoundingInfo()).toBe(mesh.getBoundingInfo());
    expect(box(instance)).toEqual({ min: [0, 0, 50], max: [6, 2, 50] });
  });

  it("holds a mesh's LOD levels too, which draw in its place, and takes a level added later", () => {
    const { scene, frame } = host();
    const { skeleton, arm } = rig(scene);
    const mesh = strip(scene, skeleton);
    followPose(mesh);
    frame();
    expect(box(mesh)).toEqual({ min: [0, 0, 0], max: [1, 2, 0] });
    // A coarser level, narrower than the mesh, whose upper edge, the arm's, reaches further out than the mesh's own:
    // neither's box holds the other's.
    const level = strip(scene, skeleton, "level", [0, 0, 0, 0.5, 0, 0, -3, 2, 0, 0.5, 2, 4]);
    mesh.addLODLevel(0.1, level);
    expect(followsPose(level)).toBe(true);
    // Asked for the level, it is its master that is followed: the level's bounds are its master's.
    expect(followPose(level)).toBe(true);
    expect(skeleton.onBeforeComputeObservable.observers).toHaveLength(1);
    frame();
    expect(box(mesh)).toEqual({ min: [-3, 0, 0], max: [1, 2, 4] });
    arm.position = new Vector3(5, 2, 0);
    frame();
    expect(box(mesh)).toEqual({ min: [0, 0, 0], max: [6, 2, 4] });
    // The level goes: the mesh's own vertices alone again.
    mesh.removeLODLevel(level);
    frame();
    expect(box(mesh)).toEqual({ min: [0, 0, 0], max: [6, 2, 0] });
    // A level something else poses is one no bounds follow: the mesh is let go with it.
    const morphed = strip(scene, skeleton, "morphed level");
    morphed.morphTargetManager = new MorphTargetManager(scene);
    mesh.addLODLevel(0.1, morphed);
    frame();
    expect(followsPose(mesh)).toBe(false);
    expect(mesh.alwaysSelectAsActiveMesh).toBe(true);
  });

  it("takes a mesh's boxes again when its geometry holds other vertices", () => {
    const { scene, frame } = host();
    const { skeleton, arm } = rig(scene);
    const mesh = strip(scene, skeleton);
    followPose(mesh);
    arm.position = new Vector3(5, 2, 0);
    frame();
    expect(box(mesh)).toEqual({ min: [0, 0, 0], max: [6, 2, 0] });
    // Two more vertices, both the arm's, further out.
    mesh.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 2, 0, 0, 2, -3, 3, 4, 0]);
    mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    frame();
    expect(box(mesh)).toEqual({ min: [0, 0, -3], max: [8, 4, 0] });
  });

  it("lets go of a mesh that loses its skeleton or gains another pose: its bounds as authored, drawn whatever the view", () => {
    const { scene, frame } = host();
    const { skeleton, arm } = rig(scene);
    const unskinned = strip(scene, skeleton, "unskinned"), morphed = strip(scene, skeleton, "morphed");
    for (const mesh of [unskinned, morphed]) followPose(mesh);
    const instance = unskinned.createInstance("instance");
    arm.position = new Vector3(5, 2, 0);
    frame();
    expect(box(unskinned).max).toEqual([6, 2, 0]);
    expect(box(instance).max).toEqual([6, 2, 0]);
    unskinned.skeleton = null;
    morphed.morphTargetManager = new MorphTargetManager(scene);
    frame();
    for (const mesh of [unskinned, morphed]) {
      expect(followsPose(mesh), mesh.name).toBe(false);
      expect(box(mesh), mesh.name).toEqual({ min: [0, 0, 0], max: [1, 2, 0] });
      expect(mesh.alwaysSelectAsActiveMesh, mesh.name).toBe(true);
    }
    // Its instance with it.
    expect(box(instance)).toEqual({ min: [0, 0, 0], max: [1, 2, 0] });
    expect(instance.alwaysSelectAsActiveMesh).toBe(true);
    // And the skeleton no longer tells them of its poses.
    expect(skeleton.onBeforeComputeObservable.hasObservers()).toBe(false);
  });

  it("leaves a hidden mesh until the frame that shows it", () => {
    const { scene, frame } = host();
    const { skeleton, arm } = rig(scene);
    const mesh = strip(scene, skeleton);
    followPose(mesh);
    frame();
    mesh.isVisible = false;
    const prepared = vi.spyOn(skeleton, "prepare");
    arm.position = new Vector3(5, 2, 0);
    frame();
    // Its skeleton is not even computed for it.
    expect(prepared).not.toHaveBeenCalled();
    expect(box(mesh).max).toEqual([1, 2, 0]);
    mesh.isVisible = true;
    frame();
    expect(box(mesh).max).toEqual([6, 2, 0]);
    // A disabled parent hides it as well.
    const parent = new Mesh("parent", scene);
    mesh.parent = parent;
    parent.setEnabled(false);
    arm.position = new Vector3(9, 2, 0);
    frame();
    expect(box(mesh).max).toEqual([6, 2, 0]);
    parent.setEnabled(true);
    frame();
    expect(box(mesh).max).toEqual([10, 2, 0]);
    // A hidden mesh's instances draw on: their bounds are kept, and the mesh's with them.
    const instance = mesh.createInstance("instance");
    mesh.isVisible = false;
    arm.position = new Vector3(20, 2, 0);
    frame();
    expect(box(instance).max).toEqual([21, 2, 0]);
  });

  it("keeps a Material's padding around the posed bounds", () => {
    const { scene, frame } = host();
    const { skeleton, arm } = rig(scene);
    const mesh = strip(scene, skeleton);
    mesh.material = { metadata: { boundsPadding: 0.5 } } as unknown as Mesh["material"];
    followPose(mesh);
    arm.position = new Vector3(5, 2, 0);
    frame();
    expect(box(mesh)).toEqual({ min: [-0.5, -0.5, -0.5], max: [6.5, 2.5, 0.5] });
  });

  it("takes a geometry's boxes once for the actors that share it, each posed by its own skeleton", () => {
    const { scene, frame } = host();
    const first = rig(scene), second = rig(scene);
    const mesh = strip(scene, first.skeleton);
    const read = vi.spyOn(Mesh.prototype, "getVerticesData");
    followPose(mesh);
    // Its positions, bone indices and weights.
    expect(read).toHaveBeenCalledTimes(3);
    // A model's next actor: the same geometry under a skeleton of its own.
    const clone = mesh.clone("clone");
    clone.skeleton = second.skeleton;
    expect(clone.geometry).toBe(mesh.geometry);
    read.mockClear();
    expect(followPose(clone)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    second.arm.position = new Vector3(5, 2, 0);
    frame();
    expect(box(mesh).max).toEqual([1, 2, 0]);
    expect(box(clone).max).toEqual([6, 2, 0]);
  });

  it("forgets a disposed mesh", () => {
    const { scene, frame } = host();
    const { skeleton } = rig(scene);
    const mesh = strip(scene, skeleton);
    followPose(mesh);
    frame();
    mesh.dispose();
    expect(followsPose(mesh)).toBe(false);
    expect(skeleton.onBeforeComputeObservable.hasObservers()).toBe(false);
    expect(() => frame()).not.toThrow();
  });
});

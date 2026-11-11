import { afterEach, expect, it } from "vitest";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene, ScenePerformancePriority } from "@babylonjs/core/scene";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
// Registers thin instances, which the fixture adds.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { BakedVertexAnimationManager } from "@babylonjs/core/BakedVertexAnimation/bakedVertexAnimationManager";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { applyMaterialBounds } from "./material-bounds";
import { drawWhateverTheView, installPlayViewCulling, markBoundsHoldInstances, settlePlayViewCulling } from "./play-view-culling";
import { skinnedRig, skinnedStrip } from "./skinned-test-fixtures";
import { markWaterSurfaceMesh } from "./water-mesh-surface";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

it("culls Play's meshes by view, except those whose bounds do not hold or that the engine always draws", () => {
  const engine = new NullEngine();
  engines.push(engine);
  // NullEngine reports no instanced arrays, which thin instances need.
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  scene.performancePriority = ScenePerformancePriority.Intermediate;
  installPlayViewCulling(scene);
  const plain = MeshBuilder.CreateBox("plain", {}, scene);
  const emitter = new Mesh("emitter", scene);
  const particles = MeshBuilder.CreateBox("particles", {}, scene);
  drawWhateverTheView(particles);
  const thin = MeshBuilder.CreateBox("thin", {}, scene);
  thin.thinInstanceAdd(Matrix.Translation(10, 0, 0));
  const skinned = MeshBuilder.CreateBox("skinned", {}, scene);
  skinned.skeleton = new Skeleton("skeleton", "skeleton", scene);
  const morphed = MeshBuilder.CreateBox("morphed", {}, scene);
  morphed.morphTargetManager = new MorphTargetManager(scene);
  const baked = MeshBuilder.CreateBox("baked", {}, scene);
  baked.bakedVertexAnimationManager = new BakedVertexAnimationManager(scene);
  // Bounds made to hold what the vertex stage does: a Material's padding, water's wave reach, and a foliage cell's,
  // refreshed to hold every instance.
  const padded = MeshBuilder.CreateBox("padded", {}, scene);
  padded.material = new StandardMaterial("offset", scene);
  padded.material.metadata = { boundsPadding: 2 };
  applyMaterialBounds(padded);
  const water = MeshBuilder.CreateGround("water", {}, scene);
  markWaterSurfaceMesh(water);
  const cell = MeshBuilder.CreateBox("cell", {}, scene);
  cell.thinInstanceAdd(Matrix.Translation(10, 0, 0));
  cell.thinInstanceRefreshBoundingInfo(true);
  markBoundsHoldInstances(cell);
  // A glTF node instance: a regular instance draws its source's geometry through its own world matrix.
  const instance = plain.createInstance("instance");
  const skinnedInstance = skinned.createInstance("skinned instance");
  const meshes = [plain, emitter, particles, thin, skinned, morphed, baked, padded, water, cell, instance, skinnedInstance];
  // Intermediate marks every mesh it constructs; the next cull settles them.
  expect(meshes.every((mesh) => mesh.alwaysSelectAsActiveMesh)).toBe(true);
  settlePlayViewCulling(scene);
  expect(Object.fromEntries(meshes.map((mesh) => [mesh.name, mesh.alwaysSelectAsActiveMesh]))).toEqual({
    plain: false, emitter: true, particles: true, thin: true, skinned: true, morphed: true, baked: true,
    padded: false, water: false, cell: false, instance: false, "skinned instance": true,
  });
  // What the cull then tests holds the padding, and the instance where it stands (a thin-instance mesh draws its
  // instances alone).
  expect(padded.getBoundingInfo().boundingBox.maximum.asArray()).toEqual([2.5, 2.5, 2.5]);
  expect(cell.getBoundingInfo().boundingBox.center.equalsWithEpsilon(new Vector3(10, 0, 0), 1e-6)).toBe(true);
});

it("culls a skinned mesh by bounds that follow its skeleton, where they can", () => {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.performancePriority = ScenePerformancePriority.Intermediate;
  installPlayViewCulling(scene);
  const { skeleton, arm } = skinnedRig(scene);
  const character = skinnedStrip(scene, skeleton, "character");
  const instance = character.createInstance("instance");
  // Morph targets move vertices past any bone's reach: no bounds follow those.
  const morphed = skinnedStrip(scene, skeleton, "morphed");
  morphed.morphTargetManager = new MorphTargetManager(scene);
  // The arm carries the strip's upper edge five units along x before the first cull.
  arm.position = new Vector3(5, 2, 0);
  const meshes = [character, instance, morphed];
  expect(meshes.every((mesh) => mesh.alwaysSelectAsActiveMesh)).toBe(true);
  settlePlayViewCulling(scene);
  expect(Object.fromEntries(meshes.map((mesh) => [mesh.name, mesh.alwaysSelectAsActiveMesh]))).toEqual({
    character: false, instance: false, morphed: true,
  });
  // The cull that follows already tests the pose: the strip as authored ends at x = 1.
  expect(character.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(6, 2);
  expect(instance.getBoundingInfo().boundingBox.maximumWorld.x).toBeCloseTo(6, 2);
  expect(morphed.getBoundingInfo().boundingBox.maximumWorld.x).toBe(1);
});

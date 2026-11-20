import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BakedVertexAnimationManager } from "@babylonjs/core/BakedVertexAnimation/bakedVertexAnimationManager";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { followPose, updatePoseBounds } from "./pose-bounds";
import { casterWithinShadowRange, deformsWithinBounds, spotShadowCone } from "./shadow-mesh-policy";
import { skinnedRig, skinnedStrip } from "./skinned-test-fixtures";

const light = Vector3.Zero();
const RANGE = 10;
let engine: NullEngine;
let scene: Scene;
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
});
afterEach(() => engine.dispose());

/** A caster whose bounding sphere is centred `distance` along +X from a light at the origin. */
function caster(distance: number) {
  const mesh = MeshBuilder.CreateSphere("caster", { diameter: 2 }, scene);
  mesh.position.x = distance;
  mesh.computeWorldMatrix(true);
  return mesh;
}
const radiusOf = () => caster(0).getBoundingInfo().boundingSphere.radiusWorld;

describe("casterWithinShadowRange", () => {
  it("reaches a rigid caster until its own radius clears the light's range", () => {
    const radius = radiusOf();
    expect(casterWithinShadowRange(caster(5), light, RANGE)).toBe(true);
    expect(casterWithinShadowRange(caster(RANGE + radius - 0.01), light, RANGE)).toBe(true);
    expect(casterWithinShadowRange(caster(RANGE + radius + 0.01), light, RANGE)).toBe(false);
    expect(casterWithinShadowRange(caster(40), light, RANGE)).toBe(false);
  });

  it.each(["skeleton", "morph targets", "baked vertex animation"] as const)(
    "gives %s geometry twice its bounding radius, and no more",
    (kind) => {
      const radius = radiusOf();
      const deform = (mesh: ReturnType<typeof caster>) => {
        if (kind === "skeleton") mesh.skeleton = new Skeleton("rig", "rig", scene);
        else if (kind === "morph targets") mesh.morphTargetManager = new MorphTargetManager(scene);
        else mesh.bakedVertexAnimationManager = new BakedVertexAnimationManager(scene);
        return mesh;
      };
      expect(casterWithinShadowRange(deform(caster(RANGE + radius * 1.5)), light, RANGE)).toBe(true);
      expect(casterWithinShadowRange(deform(caster(RANGE + radius * 2 + 0.01)), light, RANGE)).toBe(false);
      // The same position is out of range for a rigid caster.
      expect(casterWithinShadowRange(caster(RANGE + radius * 1.5), light, RANGE)).toBe(false);
    },
  );

  it("reaches a skinned caster whose bounds follow its pose only as far as those bounds", () => {
    const { skeleton, root } = skinnedRig(scene);
    const strip = skinnedStrip(scene, skeleton);
    // Posed along +x until its nearest edge is a quarter of its radius past the light's range.
    const radius = strip.getBoundingInfo().boundingSphere.radiusWorld;
    root.position = new Vector3(RANGE + radius * 1.25 - 0.5, -1, 0);
    // Not followed, its bounds are its vertices as authored, around the light: it reaches whatever its pose.
    expect(deformsWithinBounds(strip)).toBe(false);
    expect(casterWithinShadowRange(strip, light, RANGE)).toBe(true);
    expect(followPose(strip)).toBe(true);
    expect(deformsWithinBounds(strip)).toBe(true);
    // Followed, its sphere stands where it is posed: a rigid caster's rule, with no second radius.
    expect(Vector3.Distance(strip.getBoundingInfo().boundingSphere.centerWorld, light)).toBeCloseTo(RANGE + radius * 1.25, 1);
    expect(casterWithinShadowRange(strip, light, RANGE)).toBe(false);
    root.position = new Vector3(RANGE + radius * 0.5 - 0.5, -1, 0);
    engine.beginFrame();
    updatePoseBounds(scene);
    engine.endFrame();
    expect(casterWithinShadowRange(strip, light, RANGE)).toBe(true);
  });

  it("treats a non-finite range as reaching every caster", () => {
    expect(casterWithinShadowRange(caster(1e6), light, Infinity)).toBe(true);
  });
});

describe("spotShadowCone", () => {
  it("answers every spot light, each frame, in the one cone, rewritten with each light's own axis and corner angle", () => {
    // The break: a new cone object per spot light per frame. A square frustum of a quarter turn has its corners
    // atan(sqrt 2) off its axis: cos 1/sqrt 3, sin sqrt(2/3).
    const first = spotShadowCone(new Vector3(0, 0, 2), Math.PI / 2)!;
    expect(first).toEqual({ x: 0, y: 0, z: 1, cos: expect.closeTo(0.57735, 5), sin: expect.closeTo(0.8165, 4) });
    // A sixth of a turn: corners atan(sqrt(2/3)) off, cos sqrt(3/5), sin sqrt(2/5).
    const second = spotShadowCone(new Vector3(-3, 0, 0), Math.PI / 3);
    expect(second).toBe(first);
    expect(second).toEqual({ x: -1, y: 0, z: 0, cos: expect.closeTo(0.774597, 5), sin: expect.closeTo(0.632456, 5) });
    // No cone for a frustum as wide as a half-space, nor for no direction.
    expect(spotShadowCone(new Vector3(0, 1, 0), Math.PI)).toBeNull();
    expect(spotShadowCone(Vector3.Zero(), Math.PI / 2)).toBeNull();
  });

  it("keeps a caster beside the light out of a narrow cone and one ahead of it in", () => {
    const cone = spotShadowCone(new Vector3(1, 0, 0), Math.PI / 4)!;
    expect(casterWithinShadowRange(caster(5), light, RANGE, cone)).toBe(true);
    const beside = MeshBuilder.CreateSphere("beside", { diameter: 2 }, scene);
    beside.position.z = 6;
    beside.computeWorldMatrix(true);
    expect(casterWithinShadowRange(beside, light, RANGE, cone)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BakedVertexAnimationManager,
  MeshBuilder,
  MorphTargetManager,
  NullEngine,
  Scene,
  Skeleton,
  Vector3,
} from "@babylonjs/core";
import { casterWithinShadowRange } from "./shadow-mesh-policy";

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

  it("treats a non-finite range as reaching every caster", () => {
    expect(casterWithinShadowRange(caster(1e6), light, Infinity)).toBe(true);
  });
});

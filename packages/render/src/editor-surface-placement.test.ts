import { afterEach, describe, expect, it } from "vitest";
import { MeshBuilder, NullEngine, Scene, Vector3, type AbstractMesh } from "@babylonjs/core";
import { createActor, createDefaultScene } from "@haptic/core";
import { markEditorHelperMesh } from "./helper-mesh";
import {
  calculateSurfaceRestTransforms,
  traceSurfacePlacement,
} from "./editor-surface-placement";

const engines: NullEngine[] = [];
afterEach(() => {
  while (engines.length > 0) engines.pop()?.dispose();
});

function sceneWithGround(): Scene {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  // Top face at y = 0.
  const ground = MeshBuilder.CreateBox("ground", { width: 20, height: 1, depth: 20 }, scene);
  ground.position.y = -0.5;
  ground.computeWorldMatrix(true);
  return scene;
}

const down = new Vector3(0, -1, 0);

describe("traceSurfacePlacement", () => {
  it("lands on the first surface in range with a normal facing the trace", () => {
    const scene = sceneWithGround();
    const placed = traceSurfacePlacement(scene, new Vector3(1, 5, 2), down, 25);
    expect(placed.position.map((v) => +v.toFixed(5))).toEqual([1, 0, 2]);
    expect(placed.normal?.map((v) => +v.toFixed(5))).toEqual([0, 1, 0]);
  });

  it("ends at the max distance with no normal when nothing is in range", () => {
    const scene = sceneWithGround();
    const placed = traceSurfacePlacement(scene, new Vector3(0, 5, 0), down, 3);
    expect(placed.position.map((v) => +v.toFixed(5))).toEqual([0, 2, 0]);
    expect(placed.normal).toBeNull();
  });

  it("hits a wall and faces its normal back toward the trace", () => {
    const scene = sceneWithGround();
    const wall = MeshBuilder.CreateBox("wall", { width: 1, height: 4, depth: 4 }, scene);
    wall.position.set(5.5, 2, 0);
    wall.computeWorldMatrix(true);
    const placed = traceSurfacePlacement(scene, new Vector3(0, 1, 0), new Vector3(1, 0, 0), 25);
    expect(placed.position.map((v) => +v.toFixed(5))).toEqual([5, 1, 0]);
    expect(placed.normal?.map((v) => +v.toFixed(5))).toEqual([-1, 0, 0]);
  });

  it("passes through editor helpers, hidden meshes and lines", () => {
    const scene = sceneWithGround();
    const helper = MeshBuilder.CreateBox("icon", { size: 1 }, scene);
    helper.position.y = 2;
    helper.computeWorldMatrix(true);
    markEditorHelperMesh(helper);
    const hidden = MeshBuilder.CreateBox("hidden", { size: 1 }, scene);
    hidden.position.y = 3;
    hidden.computeWorldMatrix(true);
    hidden.isVisible = false;
    MeshBuilder.CreateLines("line", { points: [new Vector3(-1, 1, 0), new Vector3(1, 1, 0)] }, scene);
    const placed = traceSurfacePlacement(scene, new Vector3(0, 5, 0), down, 25);
    expect(placed.position[1]).toBeCloseTo(0, 5);
  });
});

describe("calculateSurfaceRestTransforms", () => {
  function restOne(mesh: AbstractMesh, point: [number, number, number], normal: [number, number, number]) {
    const sceneData = { ...createDefaultScene(), actors: [createActor("a", "A")] };
    sceneData.actors[0]!.transform.position = [mesh.position.x, mesh.position.y, mesh.position.z];
    return calculateSurfaceRestTransforms({
      sceneData,
      rests: [{ actorId: "a", point, normal }],
      meshForActor: (id) => (id === "a" ? mesh : null),
    });
  }

  it("lifts a centred box so its bottom rests on the floor", () => {
    const scene = sceneWithGround();
    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    const [change] = restOne(box, [0, 0, 0], [0, 1, 0]);
    expect(change!.position.map((v) => +v.toFixed(5))).toEqual([0, 0.5, 0]);
  });

  it("pushes a box out of a wall along the wall's normal", () => {
    const scene = sceneWithGround();
    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    box.position.set(5, 1, 0);
    const [change] = restOne(box, [5, 1, 0], [-1, 0, 0]);
    expect(change!.position.map((v) => +v.toFixed(5))).toEqual([4, 1, 0]);
  });

  it("leaves geometry that already sits on the surface, and lowers geometry floating above it", () => {
    const scene = sceneWithGround();
    const feet = MeshBuilder.CreateBox("feet", { size: 1 }, scene);
    feet.bakeTransformIntoVertices(feet.getWorldMatrix().clone().setTranslationFromFloats(0, 0.5, 0));
    expect(restOne(feet, [0, 0, 0], [0, 1, 0])).toEqual([]);
    const floating = MeshBuilder.CreateBox("floating", { size: 1 }, scene);
    floating.bakeTransformIntoVertices(floating.getWorldMatrix().clone().setTranslationFromFloats(0, 2.5, 0));
    const [change] = restOne(floating, [0, 0, 0], [0, 1, 0]);
    expect(change!.position.map((v) => +v.toFixed(5))).toEqual([0, -2, 0]);
  });

  it("leaves actors without visible geometry where the trace put them", () => {
    const scene = sceneWithGround();
    const empty = MeshBuilder.CreateBox("empty", { size: 1 }, scene);
    empty.metadata = { editorPickProxy: true };
    expect(restOne(empty, [0, 0, 0], [0, 1, 0])).toEqual([]);
  });
});

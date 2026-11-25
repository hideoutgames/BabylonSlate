import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { computeSortKey } from "@haptic/core";
import {
  RENDERING_GROUP,
  applySortingToMesh,
  applySortingToParticleSystem,
  compareOpaqueDraws,
  particleDrawOrderRevision,
  renderingGroupForLayer,
  resolveSortingLayer,
} from "./sorting";

describe("resolveSortingLayer", () => {
  const layers = ["Background", "Default", "Foreground", "UI"];

  it("maps reserved layer names onto the reserved rendering groups", () => {
    expect(renderingGroupForLayer("Background")).toBe(
      RENDERING_GROUP.background,
    );
    expect(renderingGroupForLayer("Foreground")).toBe(
      RENDERING_GROUP.foreground,
    );
    expect(renderingGroupForLayer("UI")).toBe(RENDERING_GROUP.ui);
    expect(renderingGroupForLayer("Default")).toBe(RENDERING_GROUP.world);
  });

  it("resolves a known layer to its index and sort key", () => {
    const resolved = resolveSortingLayer(layers, "Foreground", 3);
    expect(resolved.layerIndex).toBe(2);
    expect(resolved.renderingGroupId).toBe(RENDERING_GROUP.foreground);
    expect(resolved.sortKey).toBe(computeSortKey(2, 3));
  });

  it("falls back to Default for an unknown layer while reporting -1", () => {
    const resolved = resolveSortingLayer(layers, "Effects", 0);
    expect(resolved.layerIndex).toBe(-1);
    expect(resolved.sortKey).toBe(computeSortKey(1, 0));
  });
});

describe("applySorting", () => {
  it("writes alphaIndex and renderingGroupId onto a mesh", () => {
    const mesh = { alphaIndex: 0, renderingGroupId: 0 };
    applySortingToMesh(mesh, resolveSortingLayer(["Default"], "Default", 7));
    expect(mesh.alphaIndex).toBe(computeSortKey(0, 7));
    expect(mesh.renderingGroupId).toBe(RENDERING_GROUP.world);
  });

  it("puts a particle system in its layer's group and draws it in sort-key order", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const layers = ["Background", "Default", "Characters", "Foreground", "UI"];
    new ParticleSystem("unsorted", 1, scene);
    const sorted = (name: string, layer: string, order: number) => {
      const system = new ParticleSystem(name, 1, scene);
      applySortingToParticleSystem(system, resolveSortingLayer(layers, layer, order));
      return system;
    };
    sorted("front", "Characters", 0);
    const before = particleDrawOrderRevision(scene);
    const back = sorted("back", "Default", 5);
    sorted("tied", "Characters", 0);
    const ui = sorted("ui", "UI", -3);
    expect(back.renderingGroupId).toBe(RENDERING_GROUP.world);
    expect(ui.renderingGroupId).toBe(RENDERING_GROUP.ui);
    expect(scene.particleSystems.map((system) => system.name)).toEqual(["unsorted", "back", "front", "tied", "ui"]);
    expect(particleDrawOrderRevision(scene)).not.toBe(before);
    scene.dispose();
    engine.dispose();
  });

  it("sorts opaque draws by material first and front-to-back within each material", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const camera = new FreeCamera("cam", new Vector3(0, 0, 0), scene);
      scene.activeCamera = camera;
      camera.computeWorldMatrix();
      const matA = new StandardMaterial("matA", scene);
      const matB = new StandardMaterial("matB", scene);
      const farA = MeshBuilder.CreateBox("farA", { size: 1 }, scene);
      farA.material = matA;
      farA.position.set(0, 0, 20);
      const nearA = MeshBuilder.CreateBox("nearA", { size: 1 }, scene);
      nearA.material = matA;
      nearA.position.set(0, 0, 4);
      const midB = MeshBuilder.CreateBox("midB", { size: 1 }, scene);
      midB.material = matB;
      midB.position.set(0, 0, 10);
      for (const mesh of [farA, nearA, midB]) mesh.computeWorldMatrix(true);
      const subMeshes = [farA.subMeshes[0]!, midB.subMeshes[0]!, nearA.subMeshes[0]!];
      subMeshes.sort(compareOpaqueDraws);
      expect(subMeshes.map((sub) => sub.getMesh().name)).toEqual(["nearA", "farA", "midB"]);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
});

import { NullEngine, ParticleSystem, Scene } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { computeSortKey } from "@haptic/core";
import {
  RENDERING_GROUP,
  applySortingToMesh,
  applySortingToParticleSystem,
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
});

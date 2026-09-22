import { describe, expect, it } from "vitest";
import { outlineBindings, parseOutlineProperties } from "./outline-component";
import { normalizeScene } from "./scene";

describe("outline component authoring", () => {
  it("bounds finite authored values without quantizing color or width and rejects invalid values", () => {
    expect(parseOutlineProperties({ color: [-1, 0.123456, 3], width: 99, throughMeshes: "true" })).toEqual({
      enabled: true, color: [0, 0.123456, 1], width: 8, throughMeshes: false,
    });
    expect(parseOutlineProperties({ enabled: false, color: [1, NaN, 0], width: Infinity, throughMeshes: true })).toEqual({
      enabled: false, color: [0.03, 0.03, 0.03], width: 1, throughMeshes: true,
    });
    expect(parseOutlineProperties({ width: -2 }).width).toBe(0.25);
    expect(parseOutlineProperties({ width: 1.375 }).width).toBe(1.375);
    const sparseColor = [1, 0, 0];
    delete sparseColor[1];
    expect(parseOutlineProperties({ color: sparseColor }).color).toEqual([0.03, 0.03, 0.03]);
  });

  it("round trips independently authored components and inherited property metadata", () => {
    const scene = normalizeScene({ actors: [
      { id: "first", components: [
        { id: "mesh", classId: "MeshComponent", properties: { modelGuid: "shared-model" } },
        { id: "outline", classId: "OutlineComponent", sourceId: "class-outline", overrideKeys: ["color", "width"],
          properties: { color: [0.2, 0.4, 0.8], width: 2.5, throughMeshes: true } },
        { id: "other", classId: "OutlineComponent", properties: { enabled: false } },
      ] },
      { id: "second", components: [
        { id: "mesh", classId: "MeshComponent", properties: { modelGuid: "shared-model" } },
        { id: "outline", classId: "OutlineComponent", properties: { color: [1, 0, 0], width: 0.5 } },
      ] },
    ] });
    const restored = normalizeScene(JSON.parse(JSON.stringify(scene)));
    const first = restored.actors[0]!;
    const second = restored.actors[1]!;
    expect(first.components[1]).toMatchObject({ sourceId: "class-outline", overrideKeys: ["color", "width"] });
    expect(outlineBindings(first.id, first.components)).toEqual([
      { id: "outline", actorId: "first", enabled: true, color: [0.2, 0.4, 0.8], width: 2.5, throughMeshes: true },
      { id: "other", actorId: "first", enabled: false, color: [0.03, 0.03, 0.03], width: 1, throughMeshes: false },
    ]);
    const binding = outlineBindings(second.id, second.components)[0]!;
    expect(binding).toMatchObject({ id: "outline", actorId: "second", color: [1, 0, 0], width: 0.5 });
    binding.color[0] = 0;
    expect(second.components[1]!.properties.color).toEqual([1, 0, 0]);
    expect(outlineBindings(first.id, first.components)[0]!.color).toEqual([0.2, 0.4, 0.8]);
  });
});

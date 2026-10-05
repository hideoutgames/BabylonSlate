import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createMeshComponent, deformerBindings, parseDeformerProperties, type SerializedComponent } from "@babylonslate/core";
import { componentPropertyRows, applyPrefabPropertyDefaults } from "./component-property-rows";
import { patchInspectorComponentProperty } from "./mesh-material-properties";
import { duplicateSceneActor } from "./place-actors";
import { instantiatePrefabComponents, previewSceneFor } from "./prefab-preview";
import { defaultPropertiesFor, addableComponentsForHost } from "../panels/add-component-catalog";

describe("deformer authoring", () => {
  it("edits one bounded control through shared rows and resets to the inherited cage", () => {
    const mesh = { ...createMeshComponent("mesh-instance"), sourceId: "mesh-template" };
    const cage: SerializedComponent = { id: "cage", classId: "DeformerComponent",
      properties: { ...defaultPropertiesFor("DeformerComponent"), targetMeshComponentId: "mesh-template" } };
    const update = vi.fn();
    const rows = componentPropertyRows("owner", cage, update, {
      sortingLayers: [], collisionLayers: [], assetLabel: () => undefined, physicsWorld: "3d", onPickAsset: () => {},
      actorComponents: () => [mesh, cage, { id: "camera", classId: "CameraComponent", properties: {} }],
    });
    const target = rows.find((row) => row.label === "Target Mesh");
    if (target?.kind !== "enum") throw new Error("Missing mesh target picker");
    expect(target.value).toBe("mesh-instance");
    expect(target.options.map((option) => option.value)).toEqual(["", "mesh-instance"]);
    const point = rows.find((row) => row.id.endsWith("-offset-7"));
    if (point?.kind !== "vector3") throw new Error("Missing last control");
    point.onChange([1, 2, 3]);
    const offsets = update.mock.calls.at(-1)![1] as number[];
    expect(offsets).toEqual([...Array(21).fill(0), 1, 2, 3]);
    expect(cage.properties.offsets).toEqual(Array(24).fill(0));
    const reset = applyPrefabPropertyDefaults(rows, { ...cage, properties: { offsets } }).find((row) => row.id === point.id);
    expect(reset?.defaultValue).toEqual([1, 2, 3]);
    const resized = patchInspectorComponentProperty({ ...cage, properties: { ...cage.properties, offsets } }, "resolution", [4, 4, 4]);
    expect(resized.offsets).toEqual(Array(192).fill(0));
  });

  it("keeps duplicated, inherited and Class preview cages bound to their own mesh", () => {
    const mesh = createMeshComponent("mesh");
    const cage: SerializedComponent = { id: "cage", classId: "DeformerComponent",
      properties: { ...parseDeformerProperties({}), enabled: true, targetMeshComponentId: "mesh", offsets: [0, 1, 0] } };
    const actor = createActor("original", "Original", { components: [mesh, cage] });
    const scene = { ...createDefaultScene(), actors: [actor] };
    const copy = duplicateSceneActor(scene, actor);
    expect(deformerBindings(copy.id, copy.components)[0]!.targetMeshComponentId).toBe(copy.components[0]!.id);
    expect(actor.components[1]!.properties.targetMeshComponentId).toBe("mesh");
    const inherited = instantiatePrefabComponents([mesh, cage], "placed");
    expect(deformerBindings("placed", inherited)[0]!.targetMeshComponentId).toBe(inherited[0]!.id);
    const preview = previewSceneFor([mesh, cage]);
    const meshPreview = preview.actors.find((entry) => entry.id === "mesh")!;
    expect(deformerBindings(meshPreview.id, meshPreview.components)).toMatchObject([{ id: "cage", targetMeshComponentId: "mesh" }]);
    expect(preview.actors.find((entry) => entry.id === "cage")!.components).toEqual([]);
    expect(cage.properties.targetMeshComponentId).toBe("mesh");
  });

  it("offers world-only opt-in deformation through the component catalog", () => {
    expect(defaultPropertiesFor("DeformerComponent").enabled).toBe(false);
    expect(addableComponentsForHost({ overlay: false }).some((entry) => entry.id === "DeformerComponent")).toBe(true);
    expect(addableComponentsForHost({ overlay: true }).some((entry) => entry.id === "DeformerComponent")).toBe(false);
  });
});

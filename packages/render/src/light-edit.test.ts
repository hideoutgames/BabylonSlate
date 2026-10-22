import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedActor,
  type SerializedScene,
} from "@haptic/core";
import { isLightValueOnlySceneEdit } from "./light-edit";

type Properties = Record<string, unknown>;
const light = (id: string, classId: string, properties: Properties): SerializedActor =>
  createActor(id, id, { components: [{ id: `${id}-light`, classId, properties }] });
const point = (properties: Properties = {}) => light("lamp", "LightComponent", {
  lightKind: "point", enabled: true, castShadows: true, shadowPriority: 10, color: [1, 1, 1], intensity: 2, range: 8, ...properties,
});
const sceneOf = (actors: SerializedActor[]): SerializedScene => ({ ...createDefaultScene(), actors });
const edited = (actor: SerializedActor, properties: Properties): SerializedActor => ({
  ...actor, components: actor.components.map((component) => ({ ...component, properties: { ...component.properties, ...properties } })),
});

describe("isLightValueOnlySceneEdit", () => {
  const box = createActor("box", "Box", { components: [createMeshComponent("box-mesh", "box")] });
  const lamp = point();
  const previous = sceneOf([box, lamp]);

  it("accepts the values a light binds as uniforms, whether or not untouched actors keep their identity", () => {
    for (const properties of [{ range: 12 }, { intensity: 0 }, { color: [0.2, 0.4, 0.6] }, { range: 3, intensity: 5, color: [0, 0, 1] }])
      expect(isLightValueOnlySceneEdit(previous, sceneOf([box, edited(lamp, properties)]))).toBe(true);
    expect(isLightValueOnlySceneEdit(previous, sceneOf(structuredClone([box, edited(lamp, { range: 12 })])))).toBe(true);

    const spot = light("spot", "LightComponent", { lightKind: "spot", range: 10, innerAngle: 20, outerAngle: 40 });
    expect(isLightValueOnlySceneEdit(sceneOf([spot]), sceneOf([edited(spot, { innerAngle: 10, outerAngle: 60 })]))).toBe(true);
    const hemisphere = light("fill", "HemisphericFillLightComponent", { intensity: 0.4, color: [1, 1, 1], groundColor: [0, 0, 0] });
    expect(isLightValueOnlySceneEdit(sceneOf([hemisphere]), sceneOf([edited(hemisphere, { groundColor: [0.1, 0.1, 0.2], intensity: 0.8 })]))).toBe(true);
    const area = light("area", "AreaRectLightComponent", { width: 2, height: 1, color: [1, 1, 1], intensity: 4 });
    expect(isLightValueOnlySceneEdit(sceneOf([area]), sceneOf([edited(area, { width: 3, height: 2, intensity: 6 })]))).toBe(true);
  });

  it("rejects an edit of anything that can change a shader variant, light admission or shadow ownership", () => {
    for (const properties of [
      { enabled: false }, { castShadows: false }, { shadowPriority: 50 }, { lightKind: "spot" }, { lightKind: "directional" }, { unknown: 1 },
    ]) expect(isLightValueOnlySceneEdit(previous, sceneOf([box, edited(lamp, { range: 12, ...properties })]))).toBe(false);
    const area = light("area", "AreaRectLightComponent", { width: 2, height: 1, textureGuid: null, enabled: true });
    expect(isLightValueOnlySceneEdit(sceneOf([area]), sceneOf([edited(area, { textureGuid: "emission" })]))).toBe(false);
    expect(isLightValueOnlySceneEdit(sceneOf([area]), sceneOf([edited(area, { enabled: false })]))).toBe(false);
  });

  it("rejects a light value edit combined with any other change", () => {
    const moved = { ...edited(lamp, { range: 12 }), transform: { ...lamp.transform, position: [1, 2, 3] as [number, number, number] } };
    expect(isLightValueOnlySceneEdit(previous, sceneOf([box, moved]))).toBe(false);
    const retyped = structuredClone(box);
    retyped.components[0]!.properties.meshKind = "sphere";
    expect(isLightValueOnlySceneEdit(previous, sceneOf([retyped, edited(lamp, { range: 12 })]))).toBe(false);
    expect(isLightValueOnlySceneEdit(previous, sceneOf([box, edited(lamp, { range: 12 }), createActor("other", "Other")]))).toBe(false);
    expect(isLightValueOnlySceneEdit(previous, sceneOf([box]))).toBe(false);
    expect(isLightValueOnlySceneEdit(previous, sceneOf([edited(lamp, { range: 12 }), box]))).toBe(false);
    const settings = { ...sceneOf([box, edited(lamp, { range: 12 })]), settings: { ...previous.settings, fogEnabled: true } };
    expect(isLightValueOnlySceneEdit(previous, settings)).toBe(false);
  });

  it("does not treat the same property names on other components as light values", () => {
    const text = createActor("text", "Text", { components: [{ id: "text-3d", classId: "Text3DComponent", properties: { color: [1, 1, 1], intensity: 1 } }] });
    expect(isLightValueOnlySceneEdit(sceneOf([text]), sceneOf([edited(text, { color: [0, 0, 0] })]))).toBe(false);
  });

  it("is false without a previous scene or when nothing was replaced", () => {
    expect(isLightValueOnlySceneEdit(null, previous)).toBe(false);
    expect(isLightValueOnlySceneEdit(previous, previous)).toBe(false);
  });
});

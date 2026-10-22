import { describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedActor,
  type SerializedScene,
} from "@haptic/core";
import { isTransformOnlySceneEdit } from "./scene-transform-edit";

const box = (id: string) => createActor(id, id, { components: [createMeshComponent(`${id}-mesh`, "box")] });
const sceneOf = (actors: SerializedActor[]): SerializedScene => ({ ...createDefaultScene(), actors });
const moved = (actor: SerializedActor, x: number): SerializedActor => ({
  ...actor, transform: { ...actor.transform, position: [x, 0, 0] },
});

describe("isTransformOnlySceneEdit", () => {
  const previous = sceneOf([box("a"), box("b"), box("c")]);

  it("accepts actor and component pose edits, whether or not untouched actors keep their identity", () => {
    const [a, b, c] = previous.actors as [SerializedActor, SerializedActor, SerializedActor];
    expect(isTransformOnlySceneEdit(previous, sceneOf([a, moved(b, 4), c]))).toBe(true);
    expect(isTransformOnlySceneEdit(previous, sceneOf(structuredClone([a, moved(b, 4), c])))).toBe(true);
    const part = structuredClone(c);
    part.components[0]!.transform = { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    expect(isTransformOnlySceneEdit(previous, sceneOf([a, b, part]))).toBe(true);
  });

  it("rejects edits that leave every pose unchanged", () => {
    expect(isTransformOnlySceneEdit(null, previous)).toBe(false);
    expect(isTransformOnlySceneEdit(previous, previous)).toBe(false);
    expect(isTransformOnlySceneEdit(previous, structuredClone(previous))).toBe(false);
    expect(isTransformOnlySceneEdit(previous, { ...previous, actors: [...previous.actors] })).toBe(false);
  });

  it("rejects a pose edit combined with any other change", () => {
    const [a, b, c] = previous.actors as [SerializedActor, SerializedActor, SerializedActor];
    const property = structuredClone(c);
    property.components[0]!.properties.meshKind = "sphere";
    expect(isTransformOnlySceneEdit(previous, sceneOf([moved(a, 1), b, property]))).toBe(false);
    expect(isTransformOnlySceneEdit(previous, sceneOf([moved(a, 1), { ...b, parentId: "a" }, c]))).toBe(false);
    expect(isTransformOnlySceneEdit(previous, sceneOf([moved(a, 1), { ...b, visible: false }, c]))).toBe(false);
    expect(isTransformOnlySceneEdit(previous, sceneOf([moved(a, 1), b, c, box("d")]))).toBe(false);
    expect(isTransformOnlySceneEdit(previous, sceneOf([moved(a, 1), b]))).toBe(false);
    expect(isTransformOnlySceneEdit(previous, sceneOf([b, moved(a, 1), c]))).toBe(false);
    const settings = { ...sceneOf([moved(a, 1), b, c]), settings: { ...previous.settings, gravity: [0, -1, 0] as [number, number, number] } };
    expect(isTransformOnlySceneEdit(previous, settings)).toBe(false);
    expect(isTransformOnlySceneEdit(previous, { ...sceneOf([moved(a, 1), b, c]), name: "Renamed" })).toBe(false);
  });
});

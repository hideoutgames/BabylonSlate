import { describe, expect, it } from "vitest";
import { createActor, normalizeScene } from "./scene";
import { cloneSceneStreamingActors } from "./scene-streaming";
import { createDefaultRenderTargetCaptureProperties } from "./render-target";

describe("scene streaming instances", () => {
  it("isolates two copies, attaches roots to their own origin, and remaps local references without changing assets", () => {
    const source = [
      createActor("door", "Door", {
        components: [{ id: "switch", classId: "MeshComponent", sourceId: "prefab-mesh", properties: {
          assetGuid: "switch",
          targetActorId: "switch",
          label: "switch",
          nested: [{ guid: "switch", classId: "Actor" }, { guid: "switch", classId: "MeshComponent" }],
        } }],
      }),
      createActor("switch", "Switch", { parentId: "door", components: [
        { id: "switch", classId: "MeshComponent", properties: {} },
        { id: "light", classId: "LightComponent", parentId: "switch", properties: {} },
      ] }),
    ];
    const first = cloneSceneStreamingActors(source, { instanceId: "one", parentActorId: "origin-one" });
    const second = cloneSceneStreamingActors(source, { instanceId: "two", parentActorId: "origin-two" });
    expect(first.actors[0]?.parentId).toBe("origin-one");
    expect(second.actors[0]?.parentId).toBe("origin-two");
    expect(first.actors[1]?.parentId).toBe(first.actors[0]?.id);
    expect(first.actors.map((actor) => actor.id).some((id) => second.actors.some((actor) => actor.id === id))).toBe(false);
    expect(first.actors[0]?.components[0]?.id).not.toBe(first.actors[1]?.components[0]?.id);
    expect(first.actors[1]?.components[1]?.parentId).toBe(first.actors[1]?.components[0]?.id);
    expect(first.actors[0]?.components[0]?.properties).toEqual({
      assetGuid: "switch",
      targetActorId: first.actors[1]?.id,
      label: "switch",
      nested: [{ guid: first.actors[1]?.id, classId: "Actor" }, { guid: first.actors[0]?.components[0]?.id, classId: "MeshComponent" }],
    });
    expect(first.actors[0]?.components[0]?.sourceId).toBe("prefab-mesh");
    first.actors[0]!.transform.position[0] = 42;
    expect(source[0]?.transform.position[0]).toBe(0);
    expect(second.actors[0]?.transform.position[0]).toBe(0);
    expect(source[0]?.components[0]?.properties.targetActorId).toBe("switch");
  });

  it("normalizes a saved streaming component before it reaches asset resolution", () => {
    const scene = normalizeScene({ actors: [{ id: "stream", classId: "SceneStreamingActor", components: [
      { id: "stream-component", classId: "SceneStreamingComponent", properties: { sceneGuid: "  scene-a  ", sceneName: 42 } },
    ] }] });
    expect(scene.actors[0]?.components[0]?.properties).toEqual({ sceneGuid: "scene-a", sceneName: "" });
  });

  it("keeps capture filters local to each streamed instance without remapping the render target asset", () => {
    const source = [
      createActor("capture", "Capture", { classId: "RenderTargetCapture", components: [{
        id: "subject", classId: "RenderTargetCaptureComponent", properties: {
          ...createDefaultRenderTargetCaptureProperties(),
          renderTargetGuid: "subject", captureOnlyActors: true, actorIds: ["subject", "capture", "external"],
        },
      }] }),
      createActor("subject", "Subject"),
    ];
    const first = cloneSceneStreamingActors(source, { instanceId: "first", parentActorId: "left" });
    const second = cloneSceneStreamingActors(source, { instanceId: "second", parentActorId: "right" });
    for (const { actors } of [first, second]) {
      expect(actors[0]!.components[0]!.properties.actorIds).toEqual([actors[1]!.id, actors[0]!.id, "external"]);
      expect(actors[0]!.components[0]!.properties.renderTargetGuid).toBe("subject");
    }
    expect(first.actors[0]!.components[0]!.properties.actorIds).not.toEqual(second.actors[0]!.components[0]!.properties.actorIds);
    expect(source[0]!.components[0]!.properties.actorIds).toEqual(["subject", "capture", "external"]);
  });

  it("rejects ambiguous actor identities before producing a partially remapped instance", () => {
    expect(() => cloneSceneStreamingActors([createActor("same", "First"), createActor("same", "Second")], {
      instanceId: "one", parentActorId: "origin",
    })).toThrow("Duplicate scene actor id");
  });
});

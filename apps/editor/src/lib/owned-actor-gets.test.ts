import { describe, expect, it } from "vitest";
import { createActor, createMeshComponent, createTimelineClip, type SerializedGraph } from "@haptic/core";
import { ownedActorsOfScene, ownedGetDiagnostics, ownedTimelineClipsOfScene, refreshOwnedGetNodes } from "./owned-actor-gets";

const scene = {
  actors: [createActor("hero", "Hero", {
    classId: "Player",
    components: [createMeshComponent("body", "box"), createMeshComponent("hat", "sphere")],
  })],
};

function getNode(id: string, type: string, data: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, data };
}

describe("Get <Actor> and Get <Component> (<Actor>) in a SceneScript", () => {
  it("numbers components that share a label", () => {
    const [hero] = ownedActorsOfScene(scene);
    expect(hero?.classId).toBe("Player");
    const names = hero!.components.map((component) => component.name);
    expect(new Set(names).size).toBe(2);
    expect(names[1]).toBe(`${names[0]} 2`);
  });

  it("shows a renamed actor's current name and reports targets that are gone", () => {
    const graph: SerializedGraph = {
      nodes: [
        getNode("a", "scene.getOwnedActor", { sceneActorId: "hero", sceneActorName: "Old Name", title: "Get Old Name" }),
        getNode("c", "scene.getOwnedComponent", { sceneActorId: "hero", sceneActorName: "Old Name", sceneComponentId: "body", sceneComponentName: "Body" }),
        getNode("gone", "scene.getOwnedComponent", { sceneActorId: "hero", sceneActorName: "Hero", sceneComponentId: "removed", sceneComponentName: "Light" }),
      ],
      edges: [],
      functionGraphs: { fn: { nodes: [getNode("lost", "scene.getOwnedActor", { sceneActorId: "deleted", sceneActorName: "Crate" })], edges: [] } },
    };
    const actors = ownedActorsOfScene(scene);
    const refreshed = refreshOwnedGetNodes(graph, actors);
    expect(refreshed.nodes[0]!.data).toMatchObject({ sceneActorName: "Hero", sceneActorClassId: "Player", title: "Get Hero" });
    expect(refreshed.nodes[1]!.data.title).toBe(`Get ${actors[0]!.components[0]!.name} (Hero)`);
    // A missing component keeps its last name.
    expect(refreshed.nodes[2]).toBe(graph.nodes[2]);
    expect(refreshOwnedGetNodes(refreshed, actors)).toBe(refreshed);

    const diagnostics = ownedGetDiagnostics(refreshed, actors, { assetGuid: "assets/Level.scene.hasset", graphId: "scene:assets/Level.scene.hasset" }, "Scene");
    expect(diagnostics.map((entry) => [entry.nodeId, entry.code, entry.severity])).toEqual([
      ["gone", "scene.owned_component_missing", "error"],
      ["lost", "scene.owned_actor_missing", "error"],
    ]);
    expect(diagnostics[1]!.message).toBe("Get Crate: the actor is no longer in this Scene.");
  });
});

describe("Get <Name> Timeline Clip in a SceneScript", () => {
  it("shows a renamed clip's current name and reports a clip that is gone", () => {
    const graph: SerializedGraph = {
      nodes: [
        getNode("intro", "scene.getOwnedTimelineClip", { sceneTimelineClipId: "intro", sceneTimelineClipName: "Old", title: "Get Old Timeline Clip" }),
        getNode("gone", "scene.getOwnedTimelineClip", { sceneTimelineClipId: "removed", sceneTimelineClipName: "Outro" }),
      ],
      edges: [],
    };
    const clips = ownedTimelineClipsOfScene({ timelineClips: [createTimelineClip("intro", "Intro")] });
    const refreshed = refreshOwnedGetNodes(graph, [], clips);
    expect(refreshed.nodes[0]!.data).toMatchObject({ sceneTimelineClipName: "Intro", title: "Get Intro Timeline Clip" });
    expect(refreshed.nodes[1]).toBe(graph.nodes[1]);
    expect(refreshOwnedGetNodes(refreshed, [], clips)).toBe(refreshed);
    const diagnostics = ownedGetDiagnostics(refreshed, [], { assetGuid: "assets/Hud.scene-layer.hasset", graphId: "g" }, "Scene Layer", clips);
    expect(diagnostics.map((entry) => [entry.nodeId, entry.code, entry.message])).toEqual([
      ["gone", "scene.owned_timeline_clip_missing", "Get Outro Timeline Clip: the Timeline Clip is no longer in this Scene Layer."],
    ]);
  });
});

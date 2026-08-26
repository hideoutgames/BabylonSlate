import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  ensureEventNodeOnGraph,
  isScriptCatalogNodeAllowed,
  nativeEventStubs,
} from "./class-members";

describe("nativeEventStubs", () => {
  it("lists Begin Play, Tick, and On Actor Destroyed", () => {
    const stubs = nativeEventStubs({ parentClass: "Actor" });
    expect(stubs.map((stub) => stub.eventType)).toEqual([
      "flow.event.beginPlay",
      "flow.event.tick",
      "flow.event.destroyed",
    ]);
  });

  it("defaults to Actor events when no parent class is given", () => {
    expect(nativeEventStubs().map((stub) => stub.eventType)).toEqual([
      "flow.event.beginPlay",
      "flow.event.tick",
      "flow.event.destroyed",
    ]);
  });

  it("lists no Begin Play or Tick on BObject or ActorComponent", () => {
    expect(nativeEventStubs({ parentClass: "BObject" })).toEqual([]);
    expect(nativeEventStubs({ parentClass: "ActorComponent" })).toEqual([]);
  });

  it("lists Game Instance lifecycle and scene events, not Actor Begin Play or Destroyed", () => {
    expect(
      nativeEventStubs({ parentClass: "GameInstance" }).map((stub) => stub.eventType),
    ).toEqual([
      "flow.event.init",
      "flow.event.tick",
      "flow.event.end",
      "flow.event.firstSceneLoaded",
      "flow.event.sceneStartLoading",
      "flow.event.sceneFinishLoading",
      "flow.event.sceneExit",
    ]);
    expect(
      isScriptCatalogNodeAllowed("flow.event.beginPlay", {
        parentClass: "GameInstance",
      }),
    ).toBe(false);
    expect(
      isScriptCatalogNodeAllowed("flow.event.destroyed", {
        parentClass: "GameInstance",
      }),
    ).toBe(false);
    expect(
      isScriptCatalogNodeAllowed("flow.event.tick", {
        parentClass: "GameInstance",
      }),
    ).toBe(true);
    expect(
      isScriptCatalogNodeAllowed("flow.event.init", { parentClass: "Actor" }),
    ).toBe(false);
    expect(
      isScriptCatalogNodeAllowed("flow.event.sceneExit", {
        parentClass: "Actor",
      }),
    ).toBe(false);
    expect(
      isScriptCatalogNodeAllowed("gameInstance.getSceneReference", {
        parentClass: "GameInstance",
      }),
    ).toBe(true);
    expect(
      isScriptCatalogNodeAllowed("gameInstance.getSceneLoadingProgress", {
        parentClass: "Actor",
      }),
    ).toBe(false);
  });

  it("does not treat leftover EditorUtilityInterface as a logic host", () => {
    expect(
      nativeEventStubs({
        assetType: "EditorUtilityInterface",
        parentClass: "BObject",
      }),
    ).toEqual([]);
  });

  it("lists editor lifecycle events when ancestry includes EditorUtilityObject", () => {
    const stubs = nativeEventStubs({
      parentClass: "EditorUtilityObject",
      parentOf: (id) => (id === "EditorUtilityObject" ? "BObject" : null),
    });
    expect(stubs.map((stub) => stub.eventType)).toEqual([
      "flow.event.editorBeginPlay",
      "flow.event.editorStartup",
      "flow.event.sceneOpen",
      "flow.event.sceneSaved",
      "flow.event.editorShutdown",
    ]);
  });

  it("adds On Command Run when ancestry includes BDebugCommand", () => {
    const stubs = nativeEventStubs({
      parentClass: "BDebugCommand",
      parentOf: (id) => (id === "BDebugCommand" ? "BObject" : null),
    });
    expect(stubs.some((stub) => stub.eventType === "flow.event.commandRun")).toBe(
      true,
    );
    expect(stubs.some((stub) => stub.eventType === "flow.event.beginPlay")).toBe(
      false,
    );
  });

  it("lists On Activate, On Tick, and On Abort for BTTask instead of Begin Play", () => {
    expect(nativeEventStubs({ parentClass: "BTTask" }).map((stub) => stub.eventType)).toEqual(
      ["bt.event.activate", "bt.event.tick", "bt.event.abort"],
    );
  });

  it("lists On Evaluate for BTDecorator instead of Begin Play", () => {
    expect(
      nativeEventStubs({ parentClass: "BTDecorator" }).map((stub) => stub.eventType),
    ).toEqual(["bt.event.evaluate"]);
  });

  it("lists On Tick for BTService instead of Begin Play", () => {
    expect(nativeEventStubs({ parentClass: "BTService" }).map((stub) => stub.eventType)).toEqual(
      ["bt.event.tick"],
    );
  });

  it("lists no Actor or BT leaf events for BTComposite", () => {
    expect(nativeEventStubs({ parentClass: "BTComposite" })).toEqual([]);
  });

  it("allows collision events only on Actor graphs", () => {
    expect(
      isScriptCatalogNodeAllowed("flow.event.hit", { parentClass: "Actor" }),
    ).toBe(true);
    expect(
      isScriptCatalogNodeAllowed("flow.event.beginOverlap", {
        parentClass: "Actor",
      }),
    ).toBe(true);
    expect(
      isScriptCatalogNodeAllowed("flow.event.hit", {
        parentClass: "BObject",
      }),
    ).toBe(false);
    expect(
      isScriptCatalogNodeAllowed("flow.event.hit", {
        parentClass: "FunctionLibrary",
      }),
    ).toBe(false);
  });

  it("does not list overlay mouse events as SceneLayerActor natives", () => {
    expect(
      nativeEventStubs({ parentClass: "SceneLayerActor" }).map(
        (stub) => stub.eventType,
      ),
    ).toEqual([
      "flow.event.beginPlay",
      "flow.event.tick",
      "flow.event.destroyed",
    ]);
    expect(
      isScriptCatalogNodeAllowed("flow.event.onClick", {
        parentClass: "SceneLayerActor",
      }),
    ).toBe(true);
    expect(
      isScriptCatalogNodeAllowed("flow.event.onClick", { parentClass: "Actor" }),
    ).toBe(false);
  });

  it("lists no native events for FunctionLibrary and EditorFunctionLibrary", () => {
    expect(nativeEventStubs({ parentClass: "FunctionLibrary" })).toEqual([]);
    expect(
      nativeEventStubs({
        parentClass: "EditorFunctionLibrary",
        parentOf: (id) =>
          id === "EditorFunctionLibrary" ? "FunctionLibrary" : "BObject",
      }),
    ).toEqual([]);
  });

  it("uses BT ancestry for a project subclass of BTTask", () => {
    const stubs = nativeEventStubs({
      parentClass: "BTTask_Patrol",
      parentOf: (id) => (id === "BTTask_Patrol" ? "BTTask" : id === "BTTask" ? "BObject" : null),
    });
    expect(stubs.map((stub) => stub.eventType)).toEqual([
      "bt.event.activate",
      "bt.event.tick",
      "bt.event.abort",
    ]);
  });
});

describe("ensureEventNodeOnGraph", () => {
  it("inserts a missing Begin Play node", () => {
    const graph: SerializedGraph = { nodes: [], edges: [] };
    const next = ensureEventNodeOnGraph(graph, "flow.event.beginPlay");
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.type).toBe("flow.event.beginPlay");
  });

  it("returns the existing node when Begin Play is already on the graph", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const next = ensureEventNodeOnGraph(graph, "flow.event.beginPlay");
    expect(next).toBe(graph);
    expect(next.nodes[0]?.id).toBe("begin");
  });

  it("allows two On Click nodes bound to different 2D Buttons", () => {
    let graph: SerializedGraph = { nodes: [], edges: [] };
    graph = ensureEventNodeOnGraph(graph, "flow.event.onClick", {
      componentId: "btn-1",
      eventQualifier: "2D Button",
    });
    graph = ensureEventNodeOnGraph(graph, "flow.event.onClick", {
      componentId: "btn-2",
      eventQualifier: "2D Button 2",
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.map((node) => node.data.componentId)).toEqual([
      "btn-1",
      "btn-2",
    ]);
    expect(graph.nodes[0]?.data.title).toBe("Event On Click (2D Button)");
    expect(graph.nodes[1]?.data.title).toBe("Event On Click (2D Button 2)");
  });

  it("does not insert a second node for the same component event binding", () => {
    let graph: SerializedGraph = { nodes: [], edges: [] };
    graph = ensureEventNodeOnGraph(graph, "flow.event.onClick", {
      componentId: "btn-1",
      eventQualifier: "2D Button",
    });
    const firstId = graph.nodes[0]?.id;
    const next = ensureEventNodeOnGraph(graph, "flow.event.onClick", {
      componentId: "btn-1",
      eventQualifier: "2D Button",
    });
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.id).toBe(firstId);
  });

  it("stamps Inherited on parent custom event overrides", () => {
    const next = ensureEventNodeOnGraph(
      { nodes: [], edges: [] },
      "flow.event.custom",
      {
        name: "On Foo",
        parentClassId: "Pawn",
        eventQualifier: "Inherited",
      },
    );
    expect(next.nodes[0]?.data).toMatchObject({
      name: "On Foo",
      title: "Event On Foo (Inherited)",
      eventQualifier: "Inherited",
    });
  });

  it("allows leftover text-changed catalog nodes on Actor graphs", () => {
    expect(
      isScriptCatalogNodeAllowed("flow.event.textChanged", {
        parentClass: "Actor",
      }),
    ).toBe(true);
  });

  it("allows leftover audio-finished catalog nodes on Actor graphs", () => {
    expect(
      isScriptCatalogNodeAllowed("flow.event.audioFinished", {
        parentClass: "Actor",
      }),
    ).toBe(true);
  });
});

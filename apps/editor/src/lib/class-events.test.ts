import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  ensureEventNodeOnGraph,
  isScriptCatalogNodeAllowed,
  nativeEventStubs,
} from "./class-members";

describe("nativeEventStubs", () => {
  it("lists Actor lifecycle and Scalability events", () => {
    const stubs = nativeEventStubs({ parentClass: "Actor" });
    expect(stubs.map((stub) => stub.eventType)).toEqual([
      "flow.event.gameLoaded",
      "flow.event.scalabilityChanged",
      "flow.event.beginPlay",
      "flow.event.tick",
      "flow.event.destroyed",
    ]);
  });

  it("defaults to Actor events when no parent class is given", () => {
    expect(nativeEventStubs().map((stub) => stub.eventType)).toEqual([
      "flow.event.gameLoaded",
      "flow.event.scalabilityChanged",
      "flow.event.beginPlay",
      "flow.event.tick",
      "flow.event.destroyed",
    ]);
  });

  it("exposes lifecycle events on ActorComponent descendants without Actor collision events", () => {
    const options = { parentClass: "Counter", parentOf: (id: string) => id === "Counter" ? "ActorComponent" : id === "ActorComponent" ? "BObject" : null };
    expect(nativeEventStubs(options).map((stub) => stub.eventType)).toEqual(["flow.event.gameLoaded", "flow.event.scalabilityChanged", "flow.event.beginPlay", "flow.event.tick", "flow.event.destroyed"]);
    for (const event of nativeEventStubs(options)) expect(isScriptCatalogNodeAllowed(event.eventType, options)).toBe(true);
    expect(isScriptCatalogNodeAllowed("flow.event.hit", options)).toBe(false);
  });

  it("lists no Begin Play or Tick on BObject", () => {
    expect(nativeEventStubs({ parentClass: "BObject" })).toEqual([]);
  });

  it("lists Game Instance lifecycle and scene events, not Actor Begin Play or Destroyed", () => {
    expect(
      nativeEventStubs({ parentClass: "GameInstance" }).map((stub) => stub.eventType),
    ).toEqual([
      "flow.event.gameLoaded",
      "flow.event.scalabilityChanged",
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

  describe("subsystem lineages", () => {
    // Project classes: Save -> GameSubsystem, Weather -> SceneSubsystem,
    // RainWeather -> Weather (user -> user chain).
    const parents: Record<string, string> = {
      Save: "GameSubsystem",
      Weather: "SceneSubsystem",
      RainWeather: "Weather",
      GameSubsystem: "Subsystem",
      SceneSubsystem: "Subsystem",
      Subsystem: "BObject",
    };
    const parentOf = (id: string) => parents[id] ?? null;
    const game = { parentClass: "Save", parentOf };
    const scene = { parentClass: "RainWeather", parentOf };
    const sceneEvents = [
      "flow.event.sceneLoaded",
      "flow.event.streamedSceneLoaded",
      "flow.event.streamedSceneUnloaded",
      "flow.event.sceneLayerAdded",
      "flow.event.sceneLayerRemoved",
      "flow.event.sceneActorSpawned",
      "flow.event.sceneActorDestroyed",
    ];

    it("gives a GameSubsystem class exactly the Game Instance events", () => {
      expect(nativeEventStubs(game).map((stub) => stub.eventType)).toEqual([
        "flow.event.gameLoaded",
        "flow.event.scalabilityChanged",
        "flow.event.init",
        "flow.event.tick",
        "flow.event.end",
        "flow.event.firstSceneLoaded",
        "flow.event.sceneStartLoading",
        "flow.event.sceneFinishLoading",
        "flow.event.sceneExit",
      ]);
    });

    it("gives a SceneSubsystem subclass Init, Tick, End and the scene events", () => {
      expect(nativeEventStubs(scene).map((stub) => stub.name)).toEqual([
        "Event On Game Loaded",
        "Event On Init",
        "Event Tick",
        "Event On End",
        "Event On Scene Loaded",
        "Event On Streamed Scene Loaded",
        "Event On Streamed Scene Unloaded",
        "Event On Scene Layer Added",
        "Event On Scene Layer Removed",
        "Event On Scene Actor Spawned",
        "Event On Scene Actor Destroyed",
      ]);
    });

    it("offers the scene events only in SceneSubsystem lineages", () => {
      for (const eventType of sceneEvents) {
        expect(isScriptCatalogNodeAllowed(eventType, scene)).toBe(true);
        expect(isScriptCatalogNodeAllowed(eventType, game)).toBe(false);
        expect(
          isScriptCatalogNodeAllowed(eventType, { parentClass: "GameInstance" }),
        ).toBe(false);
        expect(
          isScriptCatalogNodeAllowed(eventType, { parentClass: "Actor" }),
        ).toBe(false);
      }
    });

    it("gates Game Instance events, getters, Tick and Scalability by subsystem lineage", () => {
      const allowed = (nodeId: string, options: typeof game) =>
        isScriptCatalogNodeAllowed(nodeId, options);
      expect(allowed("flow.event.sceneExit", game)).toBe(true);
      expect(allowed("flow.event.sceneExit", scene)).toBe(false);
      expect(allowed("gameInstance.getSceneLoadingProgress", game)).toBe(true);
      expect(allowed("gameInstance.getSceneLoadingProgress", scene)).toBe(false);
      expect(allowed("gameInstance.getSceneReference", game)).toBe(true);
      expect(allowed("gameInstance.getSceneReference", scene)).toBe(true);
      expect(allowed("flow.event.tick", game)).toBe(true);
      expect(allowed("flow.event.tick", scene)).toBe(true);
      expect(allowed("flow.event.scalabilityChanged", game)).toBe(true);
      expect(allowed("flow.event.scalabilityChanged", scene)).toBe(false);
      expect(allowed("flow.event.beginPlay", scene)).toBe(false);
    });
  });

  it("offers Get Game Instance in runtime hosts only and never the generic Get Subsystem", () => {
    for (const parentClass of ["Actor", "GameInstance", "FunctionLibrary", "BTTask", "BObject"]) {
      expect(isScriptCatalogNodeAllowed("gameInstance.get", { parentClass })).toBe(true);
    }
    const editorParentOf = (id: string) =>
      id === "EditorFunctionLibrary" ? "FunctionLibrary" : id === "BObject" ? null : "BObject";
    for (const parentClass of ["EditorUtilityObject", "EditorFunctionLibrary"]) {
      expect(
        isScriptCatalogNodeAllowed("gameInstance.get", { parentClass, parentOf: editorParentOf }),
      ).toBe(false);
    }
    expect(isScriptCatalogNodeAllowed("subsystem.get", { parentClass: "Actor" })).toBe(false);
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

  it("lists actor selection events but no component mouse events as SceneLayerActor natives", () => {
    expect(
      nativeEventStubs({ parentClass: "SceneLayerActor" }).map(
        (stub) => stub.eventType,
      ),
    ).toEqual([
      "flow.event.gameLoaded",
      "flow.event.scalabilityChanged",
      "flow.event.beginPlay",
      "flow.event.tick",
      "flow.event.destroyed",
      "flow.event.sceneLayerActorSwitchedTo",
      "flow.event.sceneLayerActorSwitchedFrom",
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

  it("offers switcher events only on the switcher lineage with readable titles", () => {
    const parents: Record<string, string> = { CustomMenu: "SceneLayerActorSwitcher", SceneLayerActorSwitcher: "SceneLayerActor", SceneLayerActor: "Actor", Actor: "BObject" };
    const options = { parentClass: "CustomMenu", parentOf: (id: string) => parents[id] };
    const events = nativeEventStubs(options);
    expect(events).toContainEqual({ eventType: "flow.event.sceneLayerActorSwitching", name: "Event On Scene Layer Actor Switching" });
    expect(events).toContainEqual({ eventType: "flow.event.sceneLayerActorSwitched", name: "Event On Scene Layer Actor Switched" });
    expect(events).toContainEqual({ eventType: "flow.event.sceneLayerActorSwitchedTo", name: "Event On Scene Layer Actor Switched To" });
    expect(isScriptCatalogNodeAllowed("flow.event.sceneLayerActorSwitching", options)).toBe(true);
    expect(isScriptCatalogNodeAllowed("flow.event.sceneLayerActorSwitching", { parentClass: "SceneLayerActor" })).toBe(false);
    expect(isScriptCatalogNodeAllowed("flow.event.sceneLayerActorSwitchedTo", { parentClass: "Actor" })).toBe(false);
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

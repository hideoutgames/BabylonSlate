import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { ensureEventNodeOnGraph, nativeEventStubs } from "./class-members";

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

  it("lists no Begin Play or Tick on BObject, GameInstance, or ActorComponent", () => {
    expect(nativeEventStubs({ parentClass: "BObject" })).toEqual([]);
    expect(nativeEventStubs({ parentClass: "GameInstance" })).toEqual([]);
    expect(nativeEventStubs({ parentClass: "ActorComponent" })).toEqual([]);
  });

  it("lists Begin Play, Tick, and On Actor Destroyed on UserInterface logic even when parentClass is BObject", () => {
    expect(
      nativeEventStubs({
        assetType: "UserInterface",
        parentClass: "BObject",
      }).map((stub) => stub.eventType),
    ).toEqual([
      "flow.event.beginPlay",
      "flow.event.tick",
      "flow.event.destroyed",
    ]);
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
});

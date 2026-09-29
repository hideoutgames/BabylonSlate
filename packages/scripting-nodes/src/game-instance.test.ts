import { describe, expect, it } from "vitest";
import { FLOAT, compileGraph, objectRef } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import { gameInstanceNodes } from "./game-instance";

describe("game instance nodes", () => {
  it("registers Get Scene Loading Progress as a pure float getter", () => {
    const node = gameInstanceNodes.find(
      (entry) => entry.id === "gameInstance.getSceneLoadingProgress",
    );
    expect(node?.title).toBe("Get Scene Loading Progress");
    expect(node?.pure).toBe(true);
    const pins = node?.pins({}) ?? [];
    expect(pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "progress",
          name: "Progress",
          direction: "out",
          type: FLOAT,
        }),
      ]),
    );
  });

  it("registers Get Scene Reference as a pure Scene object getter", () => {
    const node = gameInstanceNodes.find(
      (entry) => entry.id === "gameInstance.getSceneReference",
    );
    expect(node?.title).toBe("Get Scene Reference");
    expect(node?.pure).toBe(true);
    const pins = node?.pins({}) ?? [];
    expect(pins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "scene",
          name: "Scene",
          direction: "out",
          type: objectRef("Scene"),
        }),
      ]),
    );
  });

  it("compiles getters onto ctx scene helpers", () => {
    const registry = createDefaultNodeRegistry();
    const compiled = compileGraph(
      {
        id: "g",
        kind: "event",
        nodes: [
          {
            id: "tick",
            typeId: "flow.event.tick",
            position: { x: 0, y: 0 },
            pins: registry.get("flow.event.tick")!.pins({}),
            properties: {},
          },
          {
            id: "progress",
            typeId: "gameInstance.getSceneLoadingProgress",
            position: { x: 0, y: 80 },
            pins: registry.get("gameInstance.getSceneLoadingProgress")!.pins({}),
            properties: {},
          },
          {
            id: "scene",
            typeId: "gameInstance.getSceneReference",
            position: { x: 0, y: 160 },
            pins: registry.get("gameInstance.getSceneReference")!.pins({}),
            properties: {},
          },
          {
            id: "log",
            typeId: "debug.log",
            position: { x: 200, y: 0 },
            pins: registry.get("debug.log")!.pins({}),
            properties: {},
          },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "tick",
            sourcePinId: "execOut",
            targetNodeId: "log",
            targetPinId: "execIn",
          },
          {
            id: "e2",
            sourceNodeId: "progress",
            sourcePinId: "progress",
            targetNodeId: "log",
            targetPinId: "message",
          },
        ],
      },
      { assetGuid: "a", registry },
    );
    expect(compiled.source).toContain("ctx.getSceneLoadingProgress()");
    const sceneCompiled = compileGraph(
      {
        id: "g2",
        kind: "event",
        nodes: [
          {
            id: "tick",
            typeId: "flow.event.tick",
            position: { x: 0, y: 0 },
            pins: registry.get("flow.event.tick")!.pins({}),
            properties: {},
          },
          {
            id: "scene",
            typeId: "gameInstance.getSceneReference",
            position: { x: 0, y: 80 },
            pins: registry.get("gameInstance.getSceneReference")!.pins({}),
            properties: {},
          },
          {
            id: "log",
            typeId: "debug.log",
            position: { x: 200, y: 0 },
            pins: registry.get("debug.log")!.pins({}),
            properties: {},
          },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "tick",
            sourcePinId: "execOut",
            targetNodeId: "log",
            targetPinId: "execIn",
          },
          {
            id: "e2",
            sourceNodeId: "scene",
            sourcePinId: "scene",
            targetNodeId: "log",
            targetPinId: "message",
          },
        ],
      },
      { assetGuid: "a", registry },
    );
    expect(sceneCompiled.source).toContain("ctx.getSceneReference()");
  });

  it("feeds the session Game Instance into Cast to the project's class", () => {
    const registry = createDefaultNodeRegistry();
    const node = (
      id: string,
      typeId: string,
      properties: Record<string, unknown> = {},
    ) => ({
      id,
      typeId,
      position: { x: 0, y: 0 },
      pins: registry.get(typeId)!.pins(properties),
      properties,
    });
    const edge = (
      sourceNodeId: string,
      sourcePinId: string,
      targetNodeId: string,
      targetPinId: string,
    ) => ({
      id: `${sourceNodeId}->${targetNodeId}.${targetPinId}`,
      sourceNodeId,
      sourcePinId,
      targetNodeId,
      targetPinId,
    });
    expect(registry.get("gameInstance.get")?.pure).toBe(true);
    expect(registry.get("gameInstance.get")?.pins({})).toEqual([
      expect.objectContaining({
        id: "gameInstance",
        direction: "out",
        type: objectRef("GameInstance"),
      }),
    ]);
    const compiled = compileGraph(
      {
        id: "g",
        kind: "event",
        nodes: [
          node("begin", "flow.event.beginPlay"),
          node("gi", "gameInstance.get"),
          node("cast", "casting.cast", {
            defaultClassId: "MatchGameInstance",
            "default:class": "MatchGameInstance",
            resultKind: "objectRef",
          }),
          node("call", "functions.call", {
            classId: "MatchGameInstance",
            functionName: "Start Match",
            implicitSelf: false,
          }),
        ],
        edges: [
          edge("begin", "execOut", "cast", "execIn"),
          edge("cast", "execOut", "call", "execIn"),
          edge("gi", "gameInstance", "cast", "object"),
          edge("cast", "result", "call", "target"),
        ],
      },
      { assetGuid: "a", registry },
    );
    const body = compiled.source.replace(/export\s+function\s+/g, "function ");
    const onBeginPlay = new Function(`${body}\nreturn onBeginPlay;`)() as (
      ctx: unknown,
    ) => void;
    const session = { classId: "MatchGameInstance" };
    const calls: Array<{ target: unknown; name: string }> = [];
    onBeginPlay({
      getGameInstance: () => session,
      isA: (object: typeof session | null, classId: string) =>
        object?.classId === classId,
      invokeFunction: (target: unknown, name: string) => {
        calls.push({ target, name });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe(session);
    expect(calls[0]!.name).toBe("Start_Match");
  });
});

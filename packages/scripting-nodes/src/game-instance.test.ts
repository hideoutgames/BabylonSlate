import { describe, expect, it } from "vitest";
import { FLOAT, compileGraph, objectRef } from "@babylonslate/scripting";
import { ALL_NODE_CATEGORIES, createDefaultNodeRegistry } from "./index";
import { gameInstanceNodes } from "./game-instance";

describe("game instance nodes", () => {
  it("registers Get Scene Loading Progress as a pure float getter", () => {
    expect(ALL_NODE_CATEGORIES).toContain("game-instance");
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
});

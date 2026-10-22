import { describe, expect, it } from "vitest";
import {
  compileGraph,
  createEmptyLogicGraph,
  type CodegenContext,
} from "@haptic/scripting";
import { createDefaultNodeRegistry } from "./index";
import { navigationNodes } from "./navigation";

function emitCtx(typeId: string): { ctx: CodegenContext; emits: string[] } {
  const emits: string[] = [];
  return {
    emits,
    ctx: {
      graph: createEmptyLogicGraph("g"),
      node: {
        id: "n1",
        typeId,
        position: { x: 0, y: 0 },
        pins: [],
        properties: {},
      },
      indent: "  ",
      input: (name) => name,
      isWired: () => false,
      output: (name) => `_out_${name}`,
      emit: (s) => {
        emits.push(s);
      },
      hoist: () => {},
      requestAsync: () => {},
    },
  };
}

describe("navigation nodes", () => {
  it("emits ctx.moveTo and ctx.findPathTo", () => {
    const move = navigationNodes.find((node) => node.id === "navigation.moveTo")!;
    const { ctx, emits } = emitCtx("navigation.moveTo");
    move.codegen(ctx);
    expect(emits.join("\n")).toContain("ctx.moveTo(");
    const find = navigationNodes.find((node) => node.id === "navigation.findPathTo")!;
    const second = emitCtx("navigation.findPathTo");
    find.codegen(second.ctx);
    expect(second.emits.join("\n")).toContain("ctx.findPathTo(");
  });

  it("compiles FindPathTo onto the same tick", () => {
    const registry = createDefaultNodeRegistry();
    const compiled = compileGraph(
      {
        id: "g",
        kind: "event",
        nodes: [
          {
            id: "entry",
            typeId: "flow.event.beginPlay",
            position: { x: 0, y: 0 },
            pins: registry.get("flow.event.beginPlay")!.pins({}),
            properties: {},
          },
          {
            id: "find",
            typeId: "navigation.findPathTo",
            position: { x: 80, y: 0 },
            pins: registry.get("navigation.findPathTo")!.pins({}),
            properties: {},
          },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "entry",
            sourcePinId: "execOut",
            targetNodeId: "find",
            targetPinId: "execIn",
          },
        ],
      },
      { assetGuid: "a", registry },
    );
    expect(compiled.source).toContain("ctx.findPathTo");
  });

  it.each([
    ["navigation.getClosestNavigablePoint", "closest", "getClosestNavigablePoint"],
    ["navigation.getRandomPointInRadius", "point", "getRandomPointInRadius"],
  ] as const)("%s reports Found and keeps the point a Vector3", (typeId, pointPin, method) => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, type: string) => ({
      id, typeId: type, position: { x: 0, y: 0 }, pins: registry.get(type)!.pins({}), properties: {},
    });
    const compiled = compileGraph(
      {
        id: "g",
        kind: "event",
        nodes: [node("entry", "flow.event.beginPlay"), node("query", typeId), node("logFound", "debug.log"), node("logPoint", "debug.log")],
        edges: [
          { id: "e1", sourceNodeId: "entry", sourcePinId: "execOut", targetNodeId: "query", targetPinId: "execIn" },
          { id: "e2", sourceNodeId: "query", sourcePinId: "execOut", targetNodeId: "logFound", targetPinId: "execIn" },
          { id: "e3", sourceNodeId: "logFound", sourcePinId: "execOut", targetNodeId: "logPoint", targetPinId: "execIn" },
          { id: "e4", sourceNodeId: "query", sourcePinId: "found", targetNodeId: "logFound", targetPinId: "message" },
          { id: "e5", sourceNodeId: "query", sourcePinId: pointPin, targetNodeId: "logPoint", targetPinId: "message" },
        ],
      },
      { assetGuid: "a", registry },
    );
    const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const onBeginPlay = new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void;
    const run = (result: unknown) => {
      const logs: unknown[] = [];
      onBeginPlay({
        [method]: () => result,
        formatValue: (value: unknown) => value,
        log: (_severity: string, _category: string, value: unknown) => logs.push(value),
      });
      return logs;
    };
    expect(run(null)).toEqual([false, { x: 0, y: 0, z: 0 }]);
    expect(run({ x: 1, y: 2, z: 3 })).toEqual([true, { x: 1, y: 2, z: 3 }]);
  });

  it("Add Obstacle sends a box when Kind is unwired", () => {
    const registry = createDefaultNodeRegistry();
    const node = (id: string, type: string) => ({
      id, typeId: type, position: { x: 0, y: 0 }, pins: registry.get(type)!.pins({}), properties: {},
    });
    const compiled = compileGraph(
      {
        id: "g",
        kind: "event",
        nodes: [node("entry", "flow.event.beginPlay"), node("add", "navigation.addObstacle")],
        edges: [{ id: "e1", sourceNodeId: "entry", sourcePinId: "execOut", targetNodeId: "add", targetPinId: "execIn" }],
      },
      { assetGuid: "a", registry },
    );
    const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
    const kinds: unknown[] = [];
    (new Function(`${body}\nreturn onBeginPlay;`)() as (ctx: unknown) => void)({
      addObstacle: (kind: unknown) => {
        kinds.push(kind);
        return "obstacle-1";
      },
    });
    expect(kinds).toEqual(["box"]);
  });
});

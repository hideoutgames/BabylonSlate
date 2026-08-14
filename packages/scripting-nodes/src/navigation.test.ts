import { describe, expect, it } from "vitest";
import {
  compileGraph,
  createEmptyLogicGraph,
  type CodegenContext,
  type NodeRegistry,
} from "@babylonslate/scripting";
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
  it("registers FindPathTo, MoveTo, StopMovement, and obstacle add/remove", () => {
    expect(navigationNodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "navigation.findPathTo",
        "navigation.moveTo",
        "navigation.stopMovement",
        "navigation.isPathValid",
        "navigation.getClosestNavigablePoint",
        "navigation.getRandomPointInRadius",
        "navigation.addObstacle",
        "navigation.removeObstacle",
      ]),
    );
    const registry: NodeRegistry = createDefaultNodeRegistry();
    expect(registry.get("navigation.findPathTo")).toBeDefined();
    expect(registry.get("navigation.moveTo")).toBeDefined();
  });

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
});

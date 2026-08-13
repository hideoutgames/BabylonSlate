import { describe, expect, it } from "vitest";
import {
  compileGraph,
  createEmptyLogicGraph,
  type CodegenContext,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import { physicsNodes } from "./physics";

function emitCtx(): { ctx: CodegenContext; emits: string[] } {
  const emits: string[] = [];
  return {
    emits,
    ctx: {
      graph: createEmptyLogicGraph("g"),
      node: {
        id: "n1",
        typeId: "physics.moveCharacter",
        position: { x: 0, y: 0 },
        pins: [],
        properties: {},
      },
      indent: "  ",
      input: (name) =>
        name === "target"
          ? "actor"
          : name === "translation"
            ? "delta"
            : "0.01",
      output: (name) => `_out_${name}`,
      emit: (s) => {
        emits.push(s);
      },
      hoist: () => {},
      requestAsync: () => {},
    },
  };
}

describe("physics nodes", () => {
  it("exports at least one node definition", () => {
    expect(physicsNodes.length).toBeGreaterThanOrEqual(4);
    expect(physicsNodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "physics.lineTrace",
        "physics.sphereOverlap",
        "physics.shapeSweep",
        "physics.addImpulse",
        "physics.moveCharacter",
      ]),
    );
  });

  it("moveCharacter takes an Actor and emits ctx.moveCharacter", () => {
    const def = physicsNodes.find((n) => n.id === "physics.moveCharacter");
    expect(def).toBeDefined();
    const pins = def!.pins({});
    expect(pins.map((p) => p.id)).toEqual(
      expect.arrayContaining(["target", "translation", "offset"]),
    );
    expect(pins.find((p) => p.id === "target")?.type).toEqual({
      kind: "actorRef",
      classId: "Actor",
    });
    const { ctx, emits } = emitCtx();
    def!.codegen(ctx);
    expect(emits.join("\n")).toContain(
      "ctx.moveCharacter(actor, delta, 0.01)",
    );
    expect(emits.join("\n")).not.toContain("ctx.log");
  });

  it("compiled LineTrace returns on the same tick from ctx.lineTrace", () => {
    const registry: NodeRegistry = createDefaultNodeRegistry();
    const def = registry.get("physics.lineTrace");
    expect(def).toBeDefined();
    const node = (
      id: string,
      typeId: string,
      properties: Record<string, unknown> = {},
    ): GraphNode => ({
      id,
      typeId,
      position: { x: 0, y: 0 },
      pins: registry.get(typeId)!.pins(properties),
      properties,
    });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node("begin", "flow.event.beginPlay"),
        node("trace", "physics.lineTrace", {
          start: { x: 0, y: 10, z: 0 },
          end: { x: 0, y: -1, z: 0 },
        }),
        node("log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "trace",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "trace",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "trace",
          sourcePinId: "hit",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("ctx.lineTrace");
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const mod = new Function(`${body}\nreturn { onBeginPlay };`)() as {
      onBeginPlay: (ctx: unknown) => void;
    };
    const logs: string[] = [];
    mod.onBeginPlay({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
      lineTrace: () => ({
        hit: true,
        location: { x: 0, y: 0.5, z: 0 },
        actor: "ground",
      }),
    });
    expect(logs).toEqual(["true"]);
  });
});

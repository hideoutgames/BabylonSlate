import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  clearValidationRules,
  compileGraph,
  createEmptyLogicGraph,
  validateGraphs,
  type CodegenContext,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import { physicsNodes, registerPhysicsValidationRules } from "./physics";

function emitCtx(
  overrides: Partial<CodegenContext> = {},
): { ctx: CodegenContext; emits: string[] } {
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
      ...overrides,
    },
  };
}

describe("physics nodes", () => {
  beforeEach(() => {
    clearValidationRules();
    registerPhysicsValidationRules();
  });
  afterEach(() => {
    clearValidationRules();
  });

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

  it("Line Trace exposes Hit Result, Channel, and Hit/Location/Normal/Distance/Actor", () => {
    const registry = createDefaultNodeRegistry();
    const line = registry.get("physics.lineTrace")!;
    const pins = line.pins({});
    expect(pins.find((pin) => pin.id === "hitResult")?.type).toEqual({
      kind: "structRef",
      guid: "engine:HitResult",
    });
    expect(pins.find((pin) => pin.id === "channel")?.type).toEqual({
      kind: "enumRef",
      guid: "engine:CollisionChannel",
    });
    expect(pins.map((pin) => pin.id)).toEqual(
      expect.arrayContaining([
        "hit",
        "location",
        "normal",
        "distance",
        "actor",
      ]),
    );
    expect(pins.find((pin) => pin.id === "normal")?.type.kind).toBe("vec3");
    expect(pins.find((pin) => pin.id === "distance")?.type.kind).toBe("float");
    const { ctx, emits } = emitCtx({
      input: (name) =>
        name === "start" ? "s" : name === "end" ? "e" : "channel",
    });
    line.codegen(ctx);
    expect(emits.join("\n")).toContain("_out_normal");
    expect(emits.join("\n")).toContain("_out_distance");
  });

  it("Sphere Overlap Actors keeps physics.sphereOverlap id with Actors array and Count INT", () => {
    const overlap = physicsNodes.find((n) => n.id === "physics.sphereOverlap")!;
    expect(overlap.title).toBe("Sphere Overlap Actors");
    const pins = overlap.pins({});
    expect(pins.map((pin) => pin.id)).toEqual(
      expect.arrayContaining(["center", "radius", "channel", "actors", "count"]),
    );
    expect(pins.find((pin) => pin.id === "actors")?.type).toEqual({
      kind: "array",
      element: { kind: "actorRef", classId: "Actor" },
    });
    expect(pins.find((pin) => pin.id === "count")?.type.kind).toBe("int");
    const { ctx, emits } = emitCtx({
      input: (name) =>
        name === "center" ? "c" : name === "radius" ? "r" : "channel",
    });
    overlap.codegen(ctx);
    const source = emits.join("\n");
    expect(source).toContain("ctx.sphereOverlap");
    expect(source).toContain("__overlap.actors");
    expect(source).toContain("_out_count");
  });

  it("Sphere Shape Sweep exposes authored Radius and Hit/Location/Normal/Distance/Actor", () => {
    const sweep = physicsNodes.find((n) => n.id === "physics.shapeSweep")!;
    expect(sweep.title).toBe("Sphere Shape Sweep");
    const pins = sweep.pins({});
    expect(pins.map((pin) => pin.id)).toEqual(
      expect.arrayContaining([
        "radius",
        "hit",
        "location",
        "normal",
        "distance",
        "actor",
        "hitResult",
      ]),
    );
    expect(pins.find((pin) => pin.id === "radius")?.type.kind).toBe("float");
    const { ctx, emits } = emitCtx({
      input: (name) =>
        name === "start"
          ? "s"
          : name === "end"
            ? "e"
            : name === "radius"
              ? "0.5"
              : "channel",
    });
    sweep.codegen(ctx);
    const source = emits.join("\n");
    expect(source).toContain("radius: 0.5");
    expect(source).not.toContain("radius: 0.25");
    expect(source).toContain("_out_actor");
    expect(source).toContain("_out_normal");
    expect(source).toContain("_out_distance");
  });

  it("rejects non-positive authored Radius defaults via validation extension", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: registry.get("flow.event.beginPlay")!.pins({}),
          properties: {},
        },
        {
          id: "overlap",
          typeId: "physics.sphereOverlap",
          position: { x: 100, y: 0 },
          pins: registry.get("physics.sphereOverlap")!.pins({}),
          properties: { "default:radius": 0 },
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "overlap",
          targetPinId: "execIn",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "physics.radius")).toBe(true);
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
    const ground = { guid: "ground" };
    mod.onBeginPlay({
      formatValue: (v: unknown) => String(v),
      log: (_s: string, _c: string, message: string) => logs.push(message),
      lineTrace: () => ({
        hit: true,
        location: { x: 0, y: 0.5, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        distance: 9.5,
        actor: ground,
      }),
    });
    expect(logs).toEqual(["true"]);
  });
});

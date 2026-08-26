import { describe, expect, it } from "vitest";
import {
  BOOL,
  EXEC,
  INT,
  compileGraph,
  actorRef,
  objectRef,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry, variableNodes } from "./index";
import { localVariableIdent } from "./member-pins";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return {
    id,
    typeId,
    position: { x: 0, y: 0 },
    pins: def.pins(properties),
    properties,
  };
}

describe("variables.get / variables.set", () => {
  it("is registered under the variables category", () => {
    expect(variableNodes.map((entry) => entry.id)).toEqual([
      "variables.get",
      "variables.set",
      "variables.getValidated",
    ]);
    const registry = createDefaultNodeRegistry();
    expect(registry.get("variables.get")?.category).toBe("variables");
    expect(registry.get("variables.set")?.category).toBe("variables");
    expect(registry.get("variables.get")?.pure).toBe(true);
    expect(registry.get("variables.getValidated")?.pure).not.toBe(true);
  });

  it("types Get from typeId and names the data out after the variable", () => {
    const def = createDefaultNodeRegistry().get("variables.get")!;
    const pins = def.pins({
      variableName: "Health",
      typeId: "bool",
      implicitSelf: true,
    });
    expect(
      pins.map((pin) => ({
        id: pin.id,
        name: pin.name,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([{ id: "value", name: "Health", direction: "out", type: BOOL }]);
    expect(pins.some((pin) => pin.id === "name")).toBe(false);
    expect(pins.some((pin) => pin.id === "target")).toBe(false);
  });

  it("keeps a required Target pin when implicitSelf is false", () => {
    const def = createDefaultNodeRegistry().get("variables.get")!;
    const pins = def.pins({
      variableName: "Health",
      typeId: "float",
      classId: "Guard",
      implicitSelf: false,
    });
    expect(pins.some((pin) => pin.id === "target")).toBe(true);
    expect(pins.find((pin) => pin.id === "target")?.type).toEqual(
      objectRef("Guard"),
    );
  });

  it("types Set from typeId with exec and data pins named after the variable", () => {
    const def = createDefaultNodeRegistry().get("variables.set")!;
    const pins = def.pins({
      variableName: "Health",
      typeId: "int",
      implicitSelf: true,
    });
    expect(
      pins.map((pin) => ({
        id: pin.id,
        name: pin.name,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execIn", name: "exec", direction: "in", type: EXEC },
      { id: "execOut", name: "then", direction: "out", type: EXEC },
      { id: "value", name: "Health", direction: "in", type: INT },
      { id: "out", name: "Health", direction: "out", type: INT },
    ]);
    expect(pins.some((pin) => pin.id === "name")).toBe(false);
  });

  it("types Get Array/Map containers from container + keyTypeId", () => {
    const def = createDefaultNodeRegistry().get("variables.get")!;
    const arrayPins = def.pins({
      variableName: "Hits",
      typeId: "rotator",
      container: "array",
      implicitSelf: true,
    });
    expect(arrayPins[0]?.type).toEqual({
      kind: "array",
      element: { kind: "rotator" },
    });
    const mapPins = def.pins({
      variableName: "ByName",
      typeId: "float",
      container: "map",
      keyTypeId: "string",
      implicitSelf: true,
    });
    expect(mapPins[0]?.type.kind).toBe("map");
  });

  it("compiles implicit-self Get/Set to ctx.getVariable / ctx.setVariable", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "set", "variables.set", {
          variableName: "Health",
          typeId: "float",
          implicitSelf: true,
          "default:Health": 8,
        }),
        node(registry, "get", "variables.get", {
          variableName: "Health",
          typeId: "float",
          implicitSelf: true,
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "set",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "set",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "get",
          sourcePinId: "value",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('ctx.setVariable("Health"');
    expect(compiled.source).toContain("ctx.setVariable(\"Health\", 8)");
    expect(compiled.source).toContain('ctx.getVariable("Health")');
    expect(compiled.source).not.toContain("ctx.input(\"name\")");
  });

  it("compiles a component-ref Get to ctx.getComponentById", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "get", "variables.get", {
          variableName: "3D Text",
          typeId: "object",
          typeClassId: "Text3DComponent",
          implicitSelf: true,
          componentId: "text-1",
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "get",
          sourcePinId: "value",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain(
      'ctx.getComponentById(ctx.self, "text-1")',
    );
    expect(compiled.source).not.toContain('ctx.getVariable("3D Text")');
  });

  it("compiles a wired Target component-ref Get to getComponentById on that actor", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "get", "variables.get", {
          variableName: "3D Text",
          typeId: "object",
          typeClassId: "Text3DComponent",
          implicitSelf: false,
          classId: "Actor",
          componentId: "text-1",
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "get",
          sourcePinId: "value",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(
      /ctx\.getComponentById\([^,]+,\s*"text-1"\)/,
    );
    expect(compiled.source).not.toContain("ctx.getVariableFrom");
  });

  it("compiles engine property Get/Set with propertyKey, not the display name", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "get", "variables.get", {
          variableName: "Text",
          typeId: "string",
          implicitSelf: false,
          classId: "Text3DComponent",
          propertyKey: "text",
        }),
        node(registry, "set", "variables.set", {
          variableName: "Text",
          typeId: "string",
          implicitSelf: false,
          classId: "Text3DComponent",
          propertyKey: "text",
          "default:Text": "Hi",
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "set",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "set",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "get",
          sourcePinId: "value",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(/ctx\.getVariableFrom\([^,]+,\s*"text"\)/);
    expect(compiled.source).toMatch(/ctx\.setVariableOn\([^,]+,\s*"text"/);
    expect(compiled.source).not.toContain('ctx.getVariableFrom(ctx.input("target"), "Text")');
    expect(compiled.source).not.toContain('ctx.setVariableOn(ctx.input("target"), "Text"');
  });

  it("compiles local Get/Set to a function-scoped ident", () => {
    const registry = createDefaultNodeRegistry();
    expect(localVariableIdent("Temp")).toBe("__lv_Temp");
    const graph: LogicGraph = {
      id: "Jump",
      kind: "function",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "set", "variables.set", {
          variableName: "Temp",
          typeId: "float",
          scope: "local",
          implicitSelf: true,
          "default:Temp": 4,
        }),
        node(registry, "get", "variables.get", {
          variableName: "Temp",
          typeId: "float",
          scope: "local",
          implicitSelf: true,
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "set",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "set",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "get",
          sourcePinId: "value",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("__lv_Temp");
    expect(compiled.source).toContain("__lv_Temp = 4");
    expect(compiled.source).not.toContain("ctx.getVariable");
    expect(compiled.source).not.toContain("ctx.setVariable");
  });

  it("compiles a wired Target Get to getVariableFrom", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "spawn", "actor.spawn", { classId: "Guard" }),
        node(registry, "get", "variables.get", {
          variableName: "Health",
          typeId: "float",
          classId: "Guard",
          implicitSelf: false,
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "spawn",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "spawn",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "spawn",
          sourcePinId: "out",
          targetNodeId: "get",
          targetPinId: "target",
        },
        {
          id: "e4",
          sourceNodeId: "get",
          sourcePinId: "value",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toMatch(
      /ctx\.getVariableFrom\([^,]*spawn[^,]*,\s*"Health"/,
    );
    expect(compiled.source).toContain('"Health"');
  });

  it("compiles Set pass-through onto the named out pin", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "set", "variables.set", {
          variableName: "Health",
          typeId: "float",
          implicitSelf: true,
          "default:Health": 8,
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "set",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "set",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "set",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("_n_set_out = 8");
    expect(compiled.source).toContain("ctx.setVariable(\"Health\", 8)");
  });

  it("Validated Get uses exec, Is Valid, Not Valid, and a typed value out", () => {
    const def = createDefaultNodeRegistry().get("variables.getValidated")!;
    const pins = def.pins({
      variableName: "Target",
      typeId: "object",
      typeClassId: "Actor",
      implicitSelf: true,
    });
    expect(
      pins.map((pin) => ({
        id: pin.id,
        name: pin.name,
        direction: pin.direction,
        kind: pin.kind,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execIn", name: "exec", direction: "in", kind: "exec", type: EXEC },
      {
        id: "isValid",
        name: "Is Valid",
        direction: "out",
        kind: "exec",
        type: EXEC,
      },
      {
        id: "notValid",
        name: "Not Valid",
        direction: "out",
        kind: "exec",
        type: EXEC,
      },
      {
        id: "value",
        name: "Target",
        direction: "out",
        kind: "data",
        type: actorRef("Actor"),
      },
    ]);
  });

  it("compiles Validated Get into Is Valid and Not Valid exec branches", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "get", "variables.getValidated", {
          variableName: "Target",
          typeId: "object",
          typeClassId: "Actor",
          implicitSelf: true,
        }),
        node(registry, "ok", "debug.log", { "default:message": "ok" }),
        node(registry, "missing", "debug.log", { "default:message": "missing" }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "get",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "get",
          sourcePinId: "isValid",
          targetNodeId: "ok",
          targetPinId: "execIn",
        },
        {
          id: "e3",
          sourceNodeId: "get",
          sourcePinId: "notValid",
          targetNodeId: "missing",
          targetPinId: "execIn",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain('ctx.getVariable("Target")');
    expect(compiled.source).toMatch(/if \(.+ != null\) \{/);
    expect(compiled.source).toContain("} else {");

    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const onBeginPlay = new Function(`${body}\nreturn { onBeginPlay };`)()
      .onBeginPlay as (ctx: unknown) => void;
    const messages: string[] = [];
    const ctx = {
      getVariable: (name: string): unknown =>
        name === "Target" ? { classId: "Actor" } : undefined,
      formatValue: String,
      log: (_severity: string, _category: string, message: string) => {
        messages.push(message);
      },
    };
    onBeginPlay(ctx);
    expect(messages).toEqual(["ok"]);
    messages.length = 0;
    ctx.getVariable = () => null;
    onBeginPlay(ctx);
    expect(messages).toEqual(["missing"]);
    messages.length = 0;
    ctx.getVariable = () => undefined;
    onBeginPlay(ctx);
    expect(messages).toEqual(["missing"]);
  });
});

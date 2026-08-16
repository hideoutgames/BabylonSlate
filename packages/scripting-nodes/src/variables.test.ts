import { describe, expect, it } from "vitest";
import {
  BOOL,
  EXEC,
  FLOAT,
  INT,
  compileGraph,
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
    ]);
    const registry = createDefaultNodeRegistry();
    expect(registry.get("variables.get")?.category).toBe("variables");
    expect(registry.get("variables.set")?.category).toBe("variables");
    expect(registry.get("variables.get")?.pure).toBe(true);
  });

  it("types Get from typeId and omits the name pin", () => {
    const def = createDefaultNodeRegistry().get("variables.get")!;
    const pins = def.pins({
      variableName: "Health",
      typeId: "bool",
      implicitSelf: true,
    });
    expect(
      pins.map((pin) => ({
        id: pin.id,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([{ id: "value", direction: "out", type: BOOL }]);
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

  it("types Set from typeId with exec, value in, and pass-through out", () => {
    const def = createDefaultNodeRegistry().get("variables.set")!;
    const pins = def.pins({
      variableName: "Health",
      typeId: "int",
      implicitSelf: true,
    });
    expect(
      pins.map((pin) => ({
        id: pin.id,
        direction: pin.direction,
        type: pin.type,
      })),
    ).toEqual([
      { id: "execIn", direction: "in", type: EXEC },
      { id: "execOut", direction: "out", type: EXEC },
      { id: "value", direction: "in", type: INT },
      { id: "out", direction: "out", type: INT },
    ]);
    expect(pins.some((pin) => pin.id === "name")).toBe(false);
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
          "default:value": 8,
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
    expect(compiled.source).toContain('ctx.getVariable("Health")');
    expect(compiled.source).not.toContain("ctx.input(\"name\")");
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
          "default:value": 4,
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
    expect(compiled.source).toContain("__lv_Temp =");
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
});

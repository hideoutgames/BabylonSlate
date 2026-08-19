import { describe, expect, it, beforeEach } from "vitest";
import {
  clearValidationRules,
  registerValidationRule,
  listValidationRules,
} from "./type-context";
import { validateGraphs } from "./validate";
import {
  createEmptyLogicGraph,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
} from "./ir";
import { pin } from "./node-registry";
import {
  EXEC,
  FLOAT,
  INT,
  BOOL,
  RESOLVING_WILDCARD,
  STRING,
  BOXED_WILDCARD,
  actorRef,
  arrayOf,
  assetRef,
  classRef,
  objectRef,
  enumRef,
  structRef,
} from "./types";
import { diagnostic } from "./diagnostics";

function flowEntry(id = "entry"): GraphNode {
  return {
    id,
    typeId: "flow.entry",
    position: { x: 0, y: 0 },
    pins: [pin("execOut", "then", "out", EXEC)],
    properties: {},
  };
}

function execThen(
  sourceNodeId: string,
  targetNodeId: string,
  id = `${sourceNodeId}->${targetNodeId}`,
): GraphEdge {
  return {
    id,
    sourceNodeId,
    sourcePinId: "execOut",
    targetNodeId,
    targetPinId: "execIn",
  };
}

function typedMismatchGraph(): LogicGraph {
  return {
    id: "g1",
    kind: "event",
    nodes: [
      {
        id: "a",
        typeId: "flow.entry",
        position: { x: 0, y: 0 },
        pins: [
          pin("execOut", "then", "out", EXEC),
          pin("out", "value", "out", INT),
        ],
        properties: {},
      },
      {
        id: "b",
        typeId: "debug.log",
        position: { x: 200, y: 0 },
        pins: [
          pin("execIn", "exec", "in", EXEC),
          pin("execOut", "then", "out", EXEC),
          pin("message", "message", "in", STRING),
        ],
        properties: {},
      },
    ],
    edges: [
      execThen("a", "b", "exec"),
      {
        id: "e1",
        sourceNodeId: "a",
        sourcePinId: "out",
        targetNodeId: "b",
        targetPinId: "message",
      },
    ],
  };
}

describe("validateGraphs", () => {
  beforeEach(() => clearValidationRules());

  it("flags type mismatches", () => {
    const diags = validateGraphs([typedMismatchGraph()], {
      assetGuid: "asset-1",
    });
    expect(diags.some((d) => d.code === "type.mismatch")).toBe(true);
  });

  it("supports rule registration hook", () => {
    registerValidationRule({
      id: "test.rule",
      run(graphs, ctx) {
        return graphs.map((g) =>
          diagnostic({
            code: "test.rule",
            message: "hook fired",
            assetGuid: ctx.assetGuid,
            graphId: g.id,
          }),
        );
      },
    });
    expect(listValidationRules()).toHaveLength(1);
    const diags = validateGraphs([createEmptyLogicGraph("empty")], {
      assetGuid: "a",
    });
    expect(diags.some((d) => d.code === "test.rule")).toBe(true);
  });

  it("reports ExecuteJavaScript parse errors", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "function",
      nodes: [
        {
          id: "in",
          typeId: "flow.function.input",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "js",
          typeId: "debug.executeJavaScript",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: { body: "this is !!! invalid js {" },
        },
      ],
      edges: [execThen("in", "js")],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "js.parse")).toBe(true);
  });

  it("does not warn pin.missing_input when a default: property is authored", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
        {
          id: "add",
          typeId: "math.add",
          position: { x: 0, y: 80 },
          pins: [
            pin("a", "a", "in", INT),
            pin("b", "b", "in", INT),
            pin("out", "out", "out", INT),
          ],
          properties: { "default:a": 2, "default:b": 3 },
        },
      ],
      edges: [
        execThen("entry", "log"),
        {
          id: "data",
          sourceNodeId: "add",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });

  it("warns pin.missing_input for an unconnected required pin without a default", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
        {
          id: "add",
          typeId: "math.add",
          position: { x: 0, y: 80 },
          pins: [
            pin("a", "a", "in", INT),
            pin("b", "b", "in", INT),
            pin("out", "out", "out", INT),
          ],
          properties: {},
        },
      ],
      edges: [
        execThen("entry", "log"),
        {
          id: "data",
          sourceNodeId: "add",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.filter((d) => d.code === "pin.missing_input")).toHaveLength(2);
    expect(diags.filter((d) => d.code === "pin.missing_input")[0]?.severity).toBe(
      "warning",
    );
  });

  it("errors pin.missing_input for an unconnected required object reference", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "destroy",
          typeId: "actor.destroy",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: {},
        },
      ],
      edges: [execThen("entry", "destroy")],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    const missing = diags.find((d) => d.code === "pin.missing_input");
    expect(missing?.severity).toBe("error");
  });

  it("errors pin.invalid_default when an objectRef stores a literal", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "destroy",
          typeId: "actor.destroy",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: { "default:target": "Hero" },
        },
      ],
      edges: [execThen("entry", "destroy")],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.invalid_default")).toBe(true);
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(true);
  });

  it("does not warn pin.missing_input for an implicit-self Target", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "call",
          typeId: "flow.event.call",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("target", "target", "in", objectRef("Hero")),
          ],
          properties: { implicitSelf: true, name: "On Hit", classId: "Hero" },
        },
      ],
      edges: [execThen("entry", "call")],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });

  it("clears pin.missing_input for an unconnected classRef with a stored default", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "spawn",
          typeId: "actor.spawn",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("classId", "classId", "in", classRef("Actor")),
            pin("out", "out", "out", actorRef("Actor")),
          ],
          properties: { "default:classId": "Pawn" },
        },
      ],
      edges: [execThen("entry", "spawn")],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
    expect(diags.some((d) => d.code === "pin.invalid_default")).toBe(false);
  });

  it("clears pin.missing_input for an unconnected assetRef with a stored guid", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "play",
          typeId: "audio.play",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("asset", "asset", "in", assetRef("Audio")),
            pin("volume", "volume", "in", FLOAT),
          ],
          properties: { "default:asset": "audio-1", "default:volume": 1 },
        },
      ],
      edges: [execThen("entry", "play")],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
    expect(diags.some((d) => d.code === "member.unknown_class")).toBe(false);
  });

  it("does not error pin.invalid_default for a boxedWildcard Print value", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "print",
          typeId: "debug.print",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("value", "value", "in", BOXED_WILDCARD),
          ],
          properties: { value: "jumped" },
        },
      ],
      edges: [execThen("entry", "print")],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.invalid_default")).toBe(false);
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });

  it("flags incompatible wildcard resolution groups", () => {
    const T = RESOLVING_WILDCARD;
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "itemSrc",
          typeId: "const.float",
          position: { x: 0, y: 0 },
          pins: [pin("out", "out", "out", FLOAT)],
          properties: {},
        },
        {
          id: "arraySrc",
          typeId: "const.array",
          position: { x: 0, y: 80 },
          pins: [pin("out", "out", "out", arrayOf(STRING))],
          properties: {},
        },
        {
          id: "append",
          typeId: "array.append",
          position: { x: 200, y: 40 },
          pins: [
            pin("array", "array", "in", arrayOf(T)),
            pin("item", "item", "in", T),
            pin("out", "out", "out", arrayOf(T)),
          ],
          properties: {},
        },
        flowEntry(),
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 400, y: 40 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "itemSrc",
          sourcePinId: "out",
          targetNodeId: "append",
          targetPinId: "item",
        },
        {
          id: "e2",
          sourceNodeId: "arraySrc",
          sourcePinId: "out",
          targetNodeId: "append",
          targetPinId: "array",
        },
        execThen("entry", "log"),
        {
          id: "e3",
          sourceNodeId: "append",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "asset-1" });
    expect(diags.some((d) => d.code === "type.wildcard_group")).toBe(true);
  });

  it("flags a mismatch after resolving a wildcard to a concrete type", () => {
    const T = RESOLVING_WILDCARD;
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "src",
          typeId: "const.array",
          position: { x: 0, y: 0 },
          pins: [pin("out", "out", "out", arrayOf(FLOAT))],
          properties: {},
        },
        {
          id: "get",
          typeId: "array.get",
          position: { x: 160, y: 0 },
          pins: [
            pin("array", "array", "in", arrayOf(T)),
            pin("out", "out", "out", T),
          ],
          properties: {},
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 320, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING, "data", true),
          ],
          properties: { message: "" },
        },
        flowEntry(),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "src",
          sourcePinId: "out",
          targetNodeId: "get",
          targetPinId: "array",
        },
        {
          id: "e2",
          sourceNodeId: "get",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
        execThen("entry", "log"),
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "asset-1" });
    expect(diags.some((d) => d.code === "type.mismatch")).toBe(true);
  });

  it("flags stale Get/Set and Call nodes against the class symbol table", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
        {
          id: "get",
          typeId: "variables.get",
          position: { x: 0, y: 80 },
          pins: [pin("value", "Health", "out", FLOAT)],
          properties: {
            variableId: "missing-var",
            variableName: "Health",
            classId: "Hero",
          },
        },
        {
          id: "callFn",
          typeId: "functions.call",
          position: { x: 200, y: 80 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: { functionName: "Jump", classId: "Hero", implicitSelf: true },
        },
        {
          id: "callEvt",
          typeId: "flow.event.call",
          position: { x: 200, y: 160 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: { name: "On Hit", classId: "Hero", implicitSelf: true },
        },
      ],
      edges: [
        execThen("entry", "log"),
        execThen("entry", "callFn", "entry->callFn"),
        execThen("entry", "callEvt", "entry->callEvt"),
        {
          id: "data",
          sourceNodeId: "get",
          sourcePinId: "value",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], {
      assetGuid: "a",
      classId: "Hero",
      members: [
        { id: "var-1", name: "Armor", kind: "variable", classId: "Hero" },
      ],
    });
    expect(diags.some((d) => d.code === "member.missing_variable")).toBe(true);
    expect(diags.some((d) => d.code === "member.missing_function")).toBe(true);
    expect(diags.some((d) => d.code === "member.missing_event")).toBe(true);
  });

  it("errors when a local variable name collides with another local or class variable", () => {
    const graph: LogicGraph = {
      id: "Jump",
      kind: "function",
      nodes: [],
      edges: [],
    };
    const diags = validateGraphs([graph], {
      assetGuid: "a",
      classId: "Hero",
      activeFunctionId: "fn-1",
      members: [
        { id: "var-1", name: "Health", kind: "variable", classId: "Hero" },
        {
          id: "loc-1",
          name: "Health",
          kind: "variable",
          classId: "Hero",
          functionId: "fn-1",
        },
        {
          id: "loc-2",
          name: "Temp",
          kind: "variable",
          classId: "Hero",
          functionId: "fn-1",
        },
        {
          id: "loc-3",
          name: "Temp",
          kind: "variable",
          classId: "Hero",
          functionId: "fn-1",
        },
      ],
    });
    expect(
      diags.filter((d) => d.code === "member.local_name_conflict"),
    ).toHaveLength(2);
  });

  it("errors unknown class constraints when a known-class table is provided", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "get",
          typeId: "variables.get",
          position: { x: 0, y: 0 },
          pins: [pin("value", "Target", "out", objectRef("MissingClass"))],
          properties: {
            variableId: "var-1",
            variableName: "Target",
            typeClassId: "MissingClass",
            classId: "Hero",
          },
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], {
      assetGuid: "a",
      classId: "Hero",
      knownClassIds: new Set(["Hero", "Actor", "BObject"]),
      members: [
        {
          id: "var-1",
          name: "Target",
          kind: "variable",
          classId: "Hero",
          typeClassId: "MissingClass",
        },
      ],
    });
    expect(diags.some((d) => d.code === "member.unknown_class")).toBe(true);
  });

  it("errors pin.duplicate_connection when two data wires share an input", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "a",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [
            pin("execOut", "then", "out", EXEC),
            pin("out", "value", "out", STRING),
          ],
          properties: {},
        },
        {
          id: "b",
          typeId: "flow.entry",
          position: { x: 0, y: 80 },
          pins: [pin("out", "value", "out", STRING)],
          properties: {},
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
      ],
      edges: [
        execThen("a", "log"),
        {
          id: "e1",
          sourceNodeId: "a",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
        {
          id: "e2",
          sourceNodeId: "b",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    const duplicate = diags.filter((d) => d.code === "pin.duplicate_connection");
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toMatchObject({
      severity: "error",
      nodeId: "log",
      pinId: "message",
    });
  });

  it("does not flag multiple exec wires into the same exec input", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "a",
          typeId: "flow.entry",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "b",
          typeId: "flow.entry",
          position: { x: 0, y: 80 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "a",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "b",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.duplicate_connection")).toBe(false);
  });

  it("errors when a declared ScriptInterface method is not implemented", () => {
    const diags = validateGraphs([createEmptyLogicGraph("g")], {
      assetGuid: "a",
      implementedInterfaces: [
        {
          guid: "iface-1",
          name: "Damageable",
          methods: [{ name: "Apply Damage", pins: [] }],
        },
      ],
      members: [],
    });
    expect(diags.some((d) => d.code === "interface.unimplemented")).toBe(true);
  });

  it("errors when an interface implementation signature differs", () => {
    const diags = validateGraphs([createEmptyLogicGraph("g")], {
      assetGuid: "a",
      implementedInterfaces: [
        {
          guid: "iface-1",
          name: "Damageable",
          methods: [
            {
              name: "Apply Damage",
              pins: [{ name: "amount", typeId: "float", direction: "in" }],
            },
          ],
        },
      ],
      members: [
        {
          id: "fn-1",
          name: "Apply Damage",
          kind: "function",
          classId: "Hero",
          implementsInterface: {
            assetGuid: "iface-1",
            methodName: "Apply Damage",
          },
          pins: [{ name: "amount", typeId: "int", direction: "in" }],
        },
      ],
    });
    expect(diags.some((d) => d.code === "interface.signature_mismatch")).toBe(
      true,
    );
  });

  it("errors missing interface implementation outputs without defaults", () => {
    const graph: LogicGraph = {
      id: "Apply Damage",
      kind: "function",
      nodes: [
        {
          id: "in",
          typeId: "flow.function.input",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "out",
          typeId: "flow.function.output",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("remaining", "remaining", "in", FLOAT),
          ],
          properties: {},
        },
      ],
      edges: [execThen("in", "out")],
    };
    const diags = validateGraphs([graph], {
      assetGuid: "a",
      interfaceImplementation: true,
    });
    const missing = diags.filter((d) => d.code === "pin.missing_input");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe("error");
  });

  it("accepts an authored default on an interface implementation output", () => {
    const graph: LogicGraph = {
      id: "Apply Damage",
      kind: "function",
      nodes: [
        {
          id: "in",
          typeId: "flow.function.input",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "out",
          typeId: "flow.function.output",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("remaining", "remaining", "in", FLOAT),
          ],
          properties: { "default:remaining": 0 },
        },
      ],
      edges: [execThen("in", "out")],
    };
    const diags = validateGraphs([graph], {
      assetGuid: "a",
      interfaceImplementation: true,
    });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });

  it("errors unbound struct and enum pins and members", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "logStruct",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
        {
          id: "logEnum",
          typeId: "debug.log",
          position: { x: 200, y: 80 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
        {
          id: "get",
          typeId: "variables.get",
          position: { x: 0, y: 80 },
          pins: [pin("value", "Stats", "out", structRef(""))],
          properties: {
            variableId: "var-1",
            variableName: "Stats",
            typeId: "struct",
            classId: "Hero",
          },
        },
        {
          id: "make",
          typeId: "enum.make",
          position: { x: 0, y: 160 },
          pins: [pin("out", "out", "out", enumRef(""))],
          properties: {},
        },
      ],
      edges: [
        execThen("entry", "logStruct"),
        execThen("entry", "logEnum", "entry->logEnum"),
        {
          id: "d1",
          sourceNodeId: "get",
          sourcePinId: "value",
          targetNodeId: "logStruct",
          targetPinId: "message",
        },
        {
          id: "d2",
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "logEnum",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], {
      assetGuid: "a",
      classId: "Hero",
      members: [
        {
          id: "var-1",
          name: "Stats",
          kind: "variable",
          classId: "Hero",
          typeId: "struct",
        },
      ],
    });
    expect(diags.some((d) => d.code === "type.unbound_struct")).toBe(true);
    expect(diags.some((d) => d.code === "type.unbound_enum")).toBe(true);
  });

  it("errors unknown struct and enum guids when a known-guid table is provided", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "get",
          typeId: "variables.get",
          position: { x: 0, y: 0 },
          pins: [pin("value", "Stats", "out", structRef("missing-struct"))],
          properties: {
            variableId: "var-1",
            variableName: "Stats",
            typeId: "struct",
            typeClassId: "missing-struct",
            classId: "Hero",
          },
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], {
      assetGuid: "a",
      classId: "Hero",
      knownGuids: new Set(["struct-stats", "enum-team"]),
      members: [
        {
          id: "var-1",
          name: "Stats",
          kind: "variable",
          classId: "Hero",
          typeId: "struct",
          typeClassId: "missing-struct",
        },
      ],
    });
    expect(diags.some((d) => d.code === "ref.unknown_guid")).toBe(true);
    expect(diags.some((d) => d.code === "member.unknown_class")).toBe(false);
  });

  it("flags a type mismatch between different Structure guids", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        flowEntry(),
        {
          id: "a",
          typeId: "variables.get",
          position: { x: 0, y: 80 },
          pins: [pin("value", "Health", "out", structRef("struct-a"))],
          properties: {},
        },
        {
          id: "b",
          typeId: "variables.set",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("value", "Damage", "in", structRef("struct-b")),
          ],
          properties: { implicitSelf: true },
        },
      ],
      edges: [
        execThen("entry", "b"),
        {
          id: "e1",
          sourceNodeId: "a",
          sourcePinId: "value",
          targetNodeId: "b",
          targetPinId: "value",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "type.mismatch")).toBe(true);
  });

  it("does not diagnose leftover nodes that the compiler would not emit", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "destroy",
          typeId: "actor.destroy",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: {},
        },
        {
          id: "js",
          typeId: "debug.executeJavaScript",
          position: { x: 200, y: 80 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: { body: "this is !!! invalid js {" },
        },
        {
          id: "add",
          typeId: "math.add",
          position: { x: 200, y: 160 },
          pins: [
            pin("a", "a", "in", INT),
            pin("b", "b", "in", INT),
            pin("out", "out", "out", INT),
          ],
          properties: {},
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.nodeId === "destroy")).toBe(false);
    expect(diags.some((d) => d.nodeId === "js")).toBe(false);
    expect(diags.some((d) => d.nodeId === "add")).toBe(false);
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
    expect(diags.some((d) => d.code === "js.parse")).toBe(false);
  });

  it("still diagnoses the same leftover nodes once they sit on a compiled exec chain", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "destroy",
          typeId: "actor.destroy",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "destroy",
          targetPinId: "execIn",
        },
      ],
    };
    const missing = validateGraphs([graph], { assetGuid: "a" }).find(
      (d) => d.code === "pin.missing_input",
    );
    expect(missing?.severity).toBe("error");
    expect(missing?.nodeId).toBe("destroy");
  });

  it("does not diagnose a wired exec island with no trigger", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "print",
          typeId: "debug.print",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("value", "value", "in", objectRef("Actor")),
          ],
          properties: {},
        },
        {
          id: "delay",
          typeId: "flow.delay",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("duration", "duration", "in", FLOAT),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "print",
          sourcePinId: "execOut",
          targetNodeId: "delay",
          targetPinId: "execIn",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
    expect(diags.some((d) => d.code === "exec.unreachable")).toBe(false);

    graph.nodes.unshift({
      id: "begin",
      typeId: "flow.event.beginPlay",
      position: { x: -200, y: 0 },
      pins: [pin("execOut", "then", "out", EXEC)],
      properties: {},
    });
    graph.edges.push({
      id: "e0",
      sourceNodeId: "begin",
      sourcePinId: "execOut",
      targetNodeId: "print",
      targetPinId: "execIn",
    });
    const live = validateGraphs([graph], { assetGuid: "a" });
    expect(
      live.some((d) => d.code === "pin.missing_input" && d.nodeId === "print"),
    ).toBe(true);
  });

  it("does not diagnose an exec cycle that is not compiled", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "a",
          typeId: "debug.log",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: {},
        },
        {
          id: "b",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "a",
          sourcePinId: "execOut",
          targetNodeId: "b",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "b",
          sourcePinId: "execOut",
          targetNodeId: "a",
          targetPinId: "execIn",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "exec.cycle")).toBe(false);
  });

  it("still diagnoses an exec cycle on a compiled chain", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "a",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: {},
        },
        {
          id: "b",
          typeId: "debug.log",
          position: { x: 400, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: {},
        },
      ],
      edges: [
        {
          id: "e0",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "a",
          targetPinId: "execIn",
        },
        {
          id: "e1",
          sourceNodeId: "a",
          sourcePinId: "execOut",
          targetNodeId: "b",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "b",
          sourcePinId: "execOut",
          targetNodeId: "a",
          targetPinId: "execIn",
        },
      ],
    };
    expect(
      validateGraphs([graph], { assetGuid: "a" }).some(
        (d) => d.code === "exec.cycle",
      ),
    ).toBe(true);
  });

  it("still diagnoses a compiled exec cycle when a leftover island also cycles", () => {
    const execLog = (id: string, x: number, y: number): GraphNode => ({
      id,
      typeId: "debug.log",
      position: { x, y },
      pins: [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
      ],
      properties: {},
    });
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        execLog("deadA", 0, 80),
        execLog("deadB", 200, 80),
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        execLog("liveA", 200, 0),
        execLog("liveB", 400, 0),
      ],
      edges: [
        {
          id: "dead1",
          sourceNodeId: "deadA",
          sourcePinId: "execOut",
          targetNodeId: "deadB",
          targetPinId: "execIn",
        },
        {
          id: "dead2",
          sourceNodeId: "deadB",
          sourcePinId: "execOut",
          targetNodeId: "deadA",
          targetPinId: "execIn",
        },
        {
          id: "e0",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "liveA",
          targetPinId: "execIn",
        },
        {
          id: "e1",
          sourceNodeId: "liveA",
          sourcePinId: "execOut",
          targetNodeId: "liveB",
          targetPinId: "execIn",
        },
        {
          id: "e2",
          sourceNodeId: "liveB",
          sourcePinId: "execOut",
          targetNodeId: "liveA",
          targetPinId: "execIn",
        },
      ],
    };
    const cycle = validateGraphs([graph], { assetGuid: "a" }).find(
      (d) => d.code === "exec.cycle",
    );
    expect(cycle).toBeDefined();
    expect(["liveA", "liveB", "begin"]).toContain(cycle?.nodeId);
  });

  it("still diagnoses a Branch false arm reachable from Begin Play", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "branch",
          typeId: "flow.branch",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("true", "true", "out", EXEC),
            pin("false", "false", "out", EXEC),
            pin("condition", "condition", "in", BOOL),
          ],
          properties: {},
        },
        {
          id: "destroy",
          typeId: "actor.destroy",
          position: { x: 400, y: 80 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: {},
        },
      ],
      edges: [
        execThen("begin", "branch"),
        {
          id: "false",
          sourceNodeId: "branch",
          sourcePinId: "false",
          targetNodeId: "destroy",
          targetPinId: "execIn",
        },
      ],
    };
    const missing = validateGraphs([graph], { assetGuid: "a" }).find(
      (d) => d.code === "pin.missing_input" && d.nodeId === "destroy",
    );
    expect(missing?.severity).toBe("error");
  });

  it("does not treat a compiled pin as missing when it reads an untriggered impure node", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "begin",
          typeId: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          pins: [pin("execOut", "then", "out", EXEC)],
          properties: {},
        },
        {
          id: "log",
          typeId: "debug.log",
          position: { x: 200, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("message", "message", "in", STRING),
          ],
          properties: {},
        },
        {
          id: "trace",
          typeId: "trace.line",
          position: { x: 0, y: 80 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
            pin("hit", "hit", "out", STRING),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: {},
        },
      ],
      edges: [
        execThen("begin", "log"),
        {
          id: "data",
          sourceNodeId: "trace",
          sourcePinId: "hit",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(
      diags.some((d) => d.code === "pin.missing_input" && d.nodeId === "log"),
    ).toBe(false);
    expect(diags.some((d) => d.nodeId === "trace")).toBe(false);
  });
});

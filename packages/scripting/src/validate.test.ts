import { describe, expect, it, beforeEach } from "vitest";
import {
  clearValidationRules,
  registerValidationRule,
  listValidationRules,
} from "./type-context";
import { validateGraphs } from "./validate";
import { createEmptyLogicGraph, type LogicGraph } from "./ir";
import { pin } from "./node-registry";
import {
  EXEC,
  FLOAT,
  INT,
  RESOLVING_WILDCARD,
  STRING,
  BOXED_WILDCARD,
  actorRef,
  arrayOf,
  assetRef,
  classRef,
  objectRef,
} from "./types";
import { diagnostic } from "./diagnostics";

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
          id: "js",
          typeId: "debug.executeJavaScript",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: { body: "this is !!! invalid js {" },
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "js.parse")).toBe(true);
  });

  it("does not warn pin.missing_input when a default: property is authored", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "add",
          typeId: "math.add",
          position: { x: 0, y: 0 },
          pins: [
            pin("a", "a", "in", INT),
            pin("b", "b", "in", INT),
            pin("out", "out", "out", INT),
          ],
          properties: { "default:a": 2, "default:b": 3 },
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });

  it("warns pin.missing_input for an unconnected required pin without a default", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "add",
          typeId: "math.add",
          position: { x: 0, y: 0 },
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
        {
          id: "destroy",
          typeId: "actor.destroy",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: {},
        },
      ],
      edges: [],
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
        {
          id: "destroy",
          typeId: "actor.destroy",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("target", "target", "in", objectRef("Actor")),
          ],
          properties: { "default:target": "Hero" },
        },
      ],
      edges: [],
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
        {
          id: "call",
          typeId: "flow.event.call",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("target", "target", "in", objectRef("Hero")),
          ],
          properties: { implicitSelf: true, name: "On Hit", classId: "Hero" },
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], { assetGuid: "a" });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });

  it("clears pin.missing_input for an unconnected classRef with a stored default", () => {
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        {
          id: "spawn",
          typeId: "actor.spawn",
          position: { x: 0, y: 0 },
          pins: [
            pin("classId", "classId", "in", classRef("Actor")),
            pin("out", "out", "out", actorRef("Actor")),
          ],
          properties: { "default:classId": "Pawn" },
        },
      ],
      edges: [],
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
        {
          id: "play",
          typeId: "audio.play",
          position: { x: 0, y: 0 },
          pins: [
            pin("asset", "asset", "in", assetRef("Audio")),
            pin("volume", "volume", "in", FLOAT),
          ],
          properties: { "default:asset": "audio-1", "default:volume": 1 },
        },
      ],
      edges: [],
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
        {
          id: "print",
          typeId: "debug.print",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("value", "value", "in", BOXED_WILDCARD),
          ],
          properties: { value: "jumped" },
        },
      ],
      edges: [],
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
          pins: [pin("message", "message", "in", STRING, "data", true)],
          properties: { message: "" },
        },
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
        {
          id: "get",
          typeId: "variables.get",
          position: { x: 0, y: 0 },
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
          position: { x: 0, y: 0 },
          pins: [],
          properties: { functionName: "Jump", classId: "Hero", implicitSelf: true },
        },
        {
          id: "callEvt",
          typeId: "flow.event.call",
          position: { x: 0, y: 0 },
          pins: [],
          properties: { name: "On Hit", classId: "Hero", implicitSelf: true },
        },
      ],
      edges: [],
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
          pins: [pin("out", "value", "out", STRING)],
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
          pins: [pin("message", "message", "in", STRING)],
          properties: {},
        },
      ],
      edges: [
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
          id: "out",
          typeId: "flow.function.output",
          position: { x: 0, y: 0 },
          pins: [pin("remaining", "remaining", "in", FLOAT)],
          properties: {},
        },
      ],
      edges: [],
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
          id: "out",
          typeId: "flow.function.output",
          position: { x: 0, y: 0 },
          pins: [pin("remaining", "remaining", "in", FLOAT)],
          properties: { "default:remaining": 0 },
        },
      ],
      edges: [],
    };
    const diags = validateGraphs([graph], {
      assetGuid: "a",
      interfaceImplementation: true,
    });
    expect(diags.some((d) => d.code === "pin.missing_input")).toBe(false);
  });
});

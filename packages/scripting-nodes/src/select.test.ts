import { describe, expect, it } from "vitest";
import {
  BOOL,
  COLOR,
  FLOAT,
  INT,
  RESOLVING_WILDCARD,
  ROTATOR,
  STRING,
  TRANSFORM,
  VEC2,
  VEC3,
  VEC4,
  compileGraph,
  enumRef,
  pinTypeKey,
  resolveWildcardPinTypes,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
  type PinType,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import {
  selectNodes,
  selectOptionPinId,
  titleCaseSelectMember,
} from "./select";
import { enumMembersOf, enumValueOf } from "./enum";

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

const team = {
  enumGuid: "enum-team",
  members: [
    { name: "None", value: 0 },
    { name: "Red", value: 1 },
    { name: "Blue", value: 2 },
  ],
  "default:index": "None",
};

describe("select nodes", () => {
  it("registers fixed typed Selects and enum Select", () => {
    const ids = selectNodes.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "select.bool",
        "select.int",
        "select.float",
        "select.string",
        "select.vec2",
        "select.vec3",
        "select.vec4",
        "select.rotator",
        "select.transform",
        "select.color",
        "enum.select",
      ]),
    );
  });

  it("builds Select Bool with False/True options", () => {
    const pins = selectNodes.find((entry) => entry.id === "select.bool")!.pins({});
    expect(pins.map((pin) => pin.id)).toEqual([
      "index",
      "false",
      "true",
      "out",
    ]);
    expect(pins.find((pin) => pin.id === "index")?.type).toEqual(BOOL);
    expect(pins.find((pin) => pin.id === "false")?.type).toEqual(BOOL);
    expect(pins.find((pin) => pin.id === "out")?.type).toEqual(BOOL);
  });

  it("builds fixed typed Selects with Index plus A/B of that type", () => {
    const expected: Array<{ id: string; type: PinType; title: string }> = [
      { id: "select.int", type: INT, title: "Select Int" },
      { id: "select.float", type: FLOAT, title: "Select Float" },
      { id: "select.string", type: STRING, title: "Select String" },
      { id: "select.vec2", type: VEC2, title: "Select Vector 2" },
      { id: "select.vec3", type: VEC3, title: "Select Vector 3" },
      { id: "select.vec4", type: VEC4, title: "Select Vector 4" },
      { id: "select.rotator", type: ROTATOR, title: "Select Rotator" },
      { id: "select.transform", type: TRANSFORM, title: "Select Transform" },
      { id: "select.color", type: COLOR, title: "Select Color" },
    ];
    for (const row of expected) {
      const def = selectNodes.find((entry) => entry.id === row.id)!;
      expect(def.title).toBe(row.title);
      const pins = def.pins({});
      expect(pins.map((pin) => pin.id)).toEqual(["index", "a", "b", "out"]);
      expect(pins.find((pin) => pin.id === "index")?.type).toEqual(INT);
      expect(pins.find((pin) => pin.id === "a")?.type).toEqual(row.type);
      expect(pins.find((pin) => pin.id === "out")?.type).toEqual(row.type);
    }
  });

  it("builds enum Select with one enum index and shared resolving wildcard options", () => {
    const def = selectNodes.find((entry) => entry.id === "enum.select")!;
    expect(def.title).toBe("Select");
    const pins = def.pins(team);
    expect(pins.find((pin) => pin.id === "index")?.type).toEqual(
      enumRef("enum-team"),
    );
    expect(pins.map((pin) => pin.id)).toEqual([
      "index",
      selectOptionPinId("None"),
      selectOptionPinId("Red"),
      selectOptionPinId("Blue"),
      "out",
    ]);
    expect(pins.find((pin) => pin.id === selectOptionPinId("Red"))?.name).toBe(
      titleCaseSelectMember("Red"),
    );
    const option = pins.find((pin) => pin.id === selectOptionPinId("None"))!;
    const out = pins.find((pin) => pin.id === "out")!;
    expect(option.type).toEqual(RESOLVING_WILDCARD);
    expect(out.type).toEqual(RESOLVING_WILDCARD);
    expect(option.type).toEqual(out.type);
  });

  it("binds enum Select default index to the first member", () => {
    expect(enumValueOf({ ...team, value: undefined })).toBe("None");
    expect(enumMembersOf(team).map((member) => member.name)).toEqual([
      "None",
      "Red",
      "Blue",
    ]);
    const properties = { ...team };
    delete properties["default:index"];
    const pins = selectNodes.find((e) => e.id === "enum.select")!.pins(properties);
    expect(pins.some((pin) => pin.id === "index")).toBe(true);
  });

  it("resolves enum Select wildcards from a wired output consumer", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "sel", "enum.select", team),
        node(registry, "sink", "literal.makeFloat", {}),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "sel",
          sourcePinId: "out",
          targetNodeId: "sink",
          targetPinId: "in",
        },
      ],
    };
    const resolved = resolveWildcardPinTypes(graph);
    expect(resolved.resolved.get(pinTypeKey("sel", "out"))).toEqual(FLOAT);
    expect(
      resolved.resolved.get(pinTypeKey("sel", selectOptionPinId("Red"))),
    ).toEqual(FLOAT);
  });

  it("resolves enum Select option/output wildcards from a wired option", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "sel", "enum.select", team),
        node(registry, "lit", "literal.makeFloat", { "default:in": 1.5 }),
      ],
      edges: [
        {
          id: "e1",
          sourceNodeId: "lit",
          sourcePinId: "out",
          targetNodeId: "sel",
          targetPinId: selectOptionPinId("Red"),
        },
      ],
    };
    const resolved = resolveWildcardPinTypes(graph);
    expect(resolved.resolved.get(pinTypeKey("sel", selectOptionPinId("None")))).toEqual(
      FLOAT,
    );
    expect(resolved.resolved.get(pinTypeKey("sel", "out"))).toEqual(FLOAT);
  });

  it("compiles fixed Select and enum Select", () => {
    const registry = createDefaultNodeRegistry();
    const boolGraph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "sel", "select.bool", {
          "default:index": true,
          "default:false": false,
          "default:true": true,
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
          sourceNodeId: "sel",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const boolCompiled = compileGraph(boolGraph, { assetGuid: "a", registry });
    expect(boolCompiled.source).toMatch(/\?/);

    const enumGraph: LogicGraph = {
      id: "g2",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "sel", "enum.select", team),
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
          sourceNodeId: "sel",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const enumCompiled = compileGraph(enumGraph, { assetGuid: "a", registry });
    expect(enumCompiled.source).toContain('"Red"');
    expect(enumCompiled.source).toContain('"Blue"');
  });
});

import { describe, expect, it } from "vitest";
import {
  INT,
  STRING,
  compileGraph,
  validateGraphs,
  structRef,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";
import { structNodes } from "./struct";

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

const statsFields = [
  { name: "Health", typeId: "int" },
  { name: "Label", typeId: "string" },
];

describe("struct nodes", () => {
  it("registers Make/Break Structure plus engine rotator/color/transform nodes", () => {
    expect(structNodes.map((entry) => entry.id)).toEqual([
      "struct.make",
      "struct.break",
      "struct.makeRotator",
      "struct.breakRotator",
      "struct.makeColor",
      "struct.breakColor",
      "struct.makeTransform",
      "struct.breakTransform",
    ]);
  });

  it("types Make/Break pins from the Structure field snapshot", () => {
    const properties = {
      structGuid: "struct-stats",
      fields: statsFields,
    };
    const make = createDefaultNodeRegistry()
      .get("struct.make")!
      .pins(properties);
    expect(
      make.map((pin) => ({
        id: pin.id,
        type: pin.type,
        direction: pin.direction,
      })),
    ).toEqual([
      { id: "Health", type: INT, direction: "in" },
      { id: "Label", type: STRING, direction: "in" },
      { id: "out", type: structRef("struct-stats"), direction: "out" },
    ]);
    const brk = createDefaultNodeRegistry()
      .get("struct.break")!
      .pins(properties);
    expect(brk[0]).toMatchObject({
      id: "in",
      type: structRef("struct-stats"),
      direction: "in",
    });
    expect(brk.find((pin) => pin.id === "Health")?.type).toEqual(INT);
  });

  it("Title Cases Structure field pin displays while ids stay the field name", () => {
    const pins = createDefaultNodeRegistry()
      .get("struct.make")!
      .pins({
        structGuid: "struct-stats",
        fields: [{ name: "maxHealth", typeId: "int" }],
      });
    expect(pins.find((pin) => pin.id === "maxHealth")).toMatchObject({
      id: "maxHealth",
      name: "Max Health",
    });
    expect(pins.find((pin) => pin.id === "out")?.name).toBe("Out");
  });

  it("Title Cases engine Rotator, Color, and Transform pin displays", () => {
    const registry = createDefaultNodeRegistry();
    const rotator = registry.get("struct.makeRotator")!.pins({});
    expect(
      rotator.filter((pin) => pin.direction === "in").map((pin) => pin.name),
    ).toEqual(["Pitch", "Yaw", "Roll"]);
    const color = registry.get("struct.breakColor")!.pins({});
    expect(
      color.filter((pin) => pin.direction === "out").map((pin) => pin.name),
    ).toEqual(["R", "G", "B", "A"]);
    const transform = registry.get("struct.makeTransform")!.pins({});
    expect(
      transform.filter((pin) => pin.direction === "in").map((pin) => pin.name),
    ).toEqual(["Location", "Rotation", "Scale"]);
  });

  it("compiles Make Structure to an object literal keyed by field name", () => {
    const registry = createDefaultNodeRegistry();
    const properties = {
      structGuid: "struct-stats",
      fields: statsFields,
      "default:Health": 8,
      "default:Label": "ok",
    };
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "struct.make", properties),
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
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("Health: 8");
    expect(compiled.source).toContain('Label: "ok"');
  });

  it("keeps field pins by name when the snapshot is rewritten", () => {
    const def = createDefaultNodeRegistry().get("struct.make")!;
    const first = def.pins({
      structGuid: "s",
      fields: [
        { name: "Health", typeId: "int" },
        { name: "Mana", typeId: "float" },
      ],
    });
    const renamed = def.pins({
      structGuid: "s",
      fields: [
        { name: "Health", typeId: "int" },
        { name: "Armor", typeId: "float" },
      ],
    });
    expect(first.some((pin) => pin.id === "Mana")).toBe(true);
    expect(renamed.some((pin) => pin.id === "Mana")).toBe(false);
    expect(renamed.some((pin) => pin.id === "Health")).toBe(true);
    expect(renamed.some((pin) => pin.id === "Armor")).toBe(true);
  });

  it("uses schema defaults for local structs and lets authored values override them", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "defaults",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "struct.make", {
          structGuid: "binding-options",
          fields: [
            { name: "Scale", typeId: "float", defaultValue: 1 },
            { name: "Enabled", typeId: "bool", defaultValue: true },
            {
              name: "Key",
              typeId: "enum",
              typeClassId: "engine:Key",
              defaultValue: "Space",
            },
            { name: "Axis", typeId: "string", defaultValue: "x" },
          ],
          "default:Axis": "y",
        }),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        {
          id: "exec",
          sourceNodeId: "begin",
          sourcePinId: "execOut",
          targetNodeId: "log",
          targetPinId: "execIn",
        },
        {
          id: "value",
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const body = compiled.source.replace(
      /export\s+(async\s+)?function\s+/g,
      "$1function ",
    );
    const onBeginPlay = new Function(`${body}\nreturn onBeginPlay;`)() as (
      ctx: unknown,
    ) => void;
    const values: unknown[] = [];
    onBeginPlay({
      formatValue: (value: unknown) => value,
      log: (_severity: string, _category: string, value: unknown) =>
        values.push(value),
    });
    expect(values).toEqual([
      { Scale: 1, Enabled: true, Key: "Space", Axis: "y" },
    ]);
    expect(
      validateGraphs([graph], { assetGuid: "a" }, { registry }).filter(
        (diagnostic) =>
          diagnostic.nodeId === "make" &&
          diagnostic.code === "pin.missing_input",
      ),
    ).toEqual([]);
  });

  it("compiles Make Transform to position, quaternion rotation, and scale", () => {
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "g",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "struct.makeTransform", {
          "default:location": { x: 1, y: 2, z: 3 },
          "default:rotation": { pitch: 0, yaw: 0, roll: 0 },
          "default:scale": { x: 1, y: 1, z: 1 },
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
          sourceNodeId: "make",
          sourcePinId: "out",
          targetNodeId: "log",
          targetPinId: "message",
        },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("position:");
    expect(compiled.source).toContain("ctx.rotatorToQuat");
    expect(compiled.source).toContain("scale:");
  });
});

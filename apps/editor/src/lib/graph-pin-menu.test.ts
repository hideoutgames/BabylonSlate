import { describe, expect, it, vi } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import type { NestedMenuItem } from "@haptic/editor-kit";
import { hydrateSerializedGraphForEditor } from "../services/graph-validation";
import { addPinToNode, scriptPinMenuItems } from "./graph-pin-menu";

type Node = SerializedGraph["nodes"][number];
type Edge = SerializedGraph["edges"][number];

const at = { x: 0, y: 0 };
const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: at, data });
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge =>
  ({ id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle });

/** The graph as a Script canvas shows it: hydrated pins, operand types retyped by their wires. */
const shown = (nodes: Node[], edges: Edge[] = []) => hydrateSerializedGraphForEditor({ nodes, edges });

const ids = (items: NestedMenuItem[]) => items.map((item) => item.id);

/** The Convert Pin choices: their labels, and the one shown as current. */
function convertChoices(items: NestedMenuItem[]) {
  const submenu = items.find((item) => item.id === "convert-pin");
  if (submenu?.type !== "submenu") return null;
  const group = submenu.items[0];
  if (group?.type !== "radio-group") throw new Error("Convert Pin holds one radio group");
  return { labels: group.items.map((item) => item.label), current: group.value, choose: group.onValueChange };
}

function select(items: NestedMenuItem[], id: string) {
  const item = items.find((entry) => entry.id === id);
  if (item?.type !== undefined && item?.type !== "item") throw new Error(`${id} is not an action`);
  item!.onSelect();
}

describe("scriptPinMenuItems: Convert Pin", () => {
  it("offers every operand type on an unwired Add operand, Float current, and applies a pick as the Inspector does", () => {
    const graph = shown([node("add", "math.add", { "default:a": 2, "default:b": 3 })]);
    const commit = vi.fn();
    const items = scriptPinMenuItems(graph, "add", "a", commit);
    expect(ids(items)).toEqual(["convert-pin"]);
    const convert = convertChoices(items)!;
    expect(convert.labels).toEqual(["Integer", "Float", "Vector2", "Vector3", "Vector4"]);
    expect(convert.current).toBe("float");

    convert.choose("vec3");
    expect(commit).toHaveBeenCalledTimes(1);
    const data = (commit.mock.calls[0]![0] as SerializedGraph).nodes[0]!.data;
    expect(data.aType).toBe("vec3");
    // The old value was a Float: it goes. B keeps its own.
    expect("default:a" in data).toBe(false);
    expect(data["default:b"]).toBe(3);
  });

  it("does nothing when the current type is picked again", () => {
    const commit = vi.fn();
    convertChoices(scriptPinMenuItems(shown([node("add", "math.add")]), "add", "a", commit))!.choose("float");
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ["against a Vector3 B, A takes numbers or Vector3", "math.mul", "a", { bType: "vec3", aType: "int" }, ["Integer", "Float", "Vector3"], "int"],
    ["Modulo takes numbers only", "math.mod", "b", {}, ["Integer", "Float"], "float"],
    ["Negate takes every type", "math.negate", "in", { inType: "vec2" }, ["Integer", "Float", "Vector2", "Vector3", "Vector4"], "vec2"],
  ])("%s", (_label, type, pinId, data, labels, current) => {
    expect(convertChoices(scriptPinMenuItems(shown([node("op", type, data)]), "op", pinId, vi.fn())))
      .toEqual({ labels, current, choose: expect.any(Function) });
  });

  it("offers a wired operand only the types its wire keeps", () => {
    // An Integer wire: Integer, or Float (an Integer widens into it).
    const intSource = node("ints", "math.add", { aType: "int", bType: "int" });
    const intWired = shown([intSource, node("add", "math.add")], [wire("ints", "out", "add", "a")]);
    expect(convertChoices(scriptPinMenuItems(intWired, "add", "a", vi.fn())))
      .toEqual({ labels: ["Integer", "Float"], current: "int", choose: expect.any(Function) });
    // The unwired B is not limited by A's wire.
    expect(convertChoices(scriptPinMenuItems(intWired, "add", "b", vi.fn()))?.labels).toHaveLength(5);
  });

  it.each([
    ["Float", { aType: "float", bType: "float" }],
    ["Vector3", { aType: "vec3", bType: "vec3" }],
  ])("leaves Convert Pin out for an operand wired from a %s, its only choice", (_label, sourceData) => {
    const graph = shown([node("source", "math.add", sourceData), node("add", "math.add")], [wire("source", "out", "add", "a")]);
    expect(ids(scriptPinMenuItems(graph, "add", "a", vi.fn()))).toEqual([]);
  });

  it("has nothing for a math node's output or another node's pins", () => {
    expect(scriptPinMenuItems(shown([node("add", "math.add")]), "add", "out", vi.fn())).toEqual([]);
    expect(scriptPinMenuItems(shown([node("log", "debug.log")]), "log", "message", vi.fn())).toEqual([]);
    expect(scriptPinMenuItems(shown([]), "missing", "a", vi.fn())).toEqual([]);
  });
});

describe("scriptPinMenuItems: Add Pin and Remove Pin", () => {
  it.each([
    ["a Make Array item", "array.make", { count: 2 }, "item1", ["add-pin", "remove-pin"]],
    ["Make Array's output", "array.make", { count: 2 }, "out", ["add-pin"]],
    ["a full Make Array's item", "array.make", { count: 32 }, "item5", ["remove-pin"]],
    ["a Make Map value", "map.make", {}, "value0", ["add-pin", "remove-pin"]],
    ["a Sequence output", "flow.sequence", {}, "then1", ["add-pin", "remove-pin"]],
    ["the only Sequence output", "flow.sequence", { count: 1 }, "then0", ["add-pin"]],
    ["Sequence's exec input", "flow.sequence", {}, "execIn", ["add-pin"]],
  ])("on %s offers %j", (_label, type, data, pinId, expected) => {
    expect(ids(scriptPinMenuItems(shown([node("n", type, data)]), "n", pinId, vi.fn()))).toEqual(expected);
  });

  it("Add Pin raises the count by one, in one change", () => {
    const commit = vi.fn();
    select(scriptPinMenuItems(shown([node("seq", "flow.sequence")]), "seq", "execIn", commit), "add-pin");
    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0]![0] as SerializedGraph).nodes[0]!.data.count).toBe(3);
  });

  it("Remove Pin drops that entry and moves the later ones down with their wires and values, in one change", () => {
    const graph = shown(
      [
        node("a", "math.add", { aType: "int", bType: "int" }),
        node("b", "math.add", { aType: "int", bType: "int" }),
        node("make", "array.make", { count: 3, "default:item2": 9 }),
      ],
      [wire("a", "out", "make", "item0"), wire("b", "out", "make", "item1")],
    );
    const commit = vi.fn();
    select(scriptPinMenuItems(graph, "make", "item0", commit), "remove-pin");
    expect(commit).toHaveBeenCalledTimes(1);
    const next = commit.mock.calls[0]![0] as SerializedGraph;
    const make = next.nodes.find((entry) => entry.id === "make")!;
    expect(make.data.count).toBe(2);
    expect(make.data["default:item1"]).toBe(9);
    expect(make.data["default:item2"]).toBeUndefined();
    expect(next.edges.map((edge) => [edge.source, edge.targetHandle])).toEqual([["b", "item0"]]);
    // The other nodes are left as they were.
    expect(next.nodes.filter((entry) => entry.id !== "make")).toEqual(graph.nodes.filter((entry) => entry.id !== "make"));
  });
});

describe("addPinToNode", () => {
  it("raises a growable list's count, and is null at its maximum or for any other node", () => {
    expect(addPinToNode(shown([node("m", "map.make")]), "m")?.nodes[0]!.data.count).toBe(2);
    expect(addPinToNode(shown([node("m", "map.make", { count: 32 })]), "m")).toBeNull();
    expect(addPinToNode(shown([node("add", "math.add")]), "add")).toBeNull();
  });
});

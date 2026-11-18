import { describe, expect, it } from "vitest";
import { pinListEntryIndex, removePinListEntry } from "./graph-pin-lists";

const into = (target: string, targetHandle: string, source = "src") =>
  ({ id: `${source}->${target}.${targetHandle}`, source, sourceHandle: "out", target, targetHandle });

describe("pinListEntryIndex", () => {
  it.each([
    ["array.make", "item3", 3],
    ["array.make", "item0", 0],
    ["map.make", "key2", 2],
    ["map.make", "value2", 2],
    ["flow.sequence", "then1", 1],
    ["array.make", "out", undefined],
    ["array.make", "item", undefined],
    ["array.make", "item01", undefined],
    ["map.make", "item1", undefined],
    ["flow.sequence", "execIn", undefined],
    ["math.add", "a", undefined],
  ])("%s pin %s is entry %s", (typeId, pinId, index) => {
    expect(pinListEntryIndex(typeId, pinId)).toBe(index);
  });
});

describe("removePinListEntry", () => {
  it("removes a Make Array item and moves the later items down with their wires and values", () => {
    const edges = [
      into("make", "item0", "a"),
      into("make", "item1", "b"),
      into("make", "item2", "c"),
      // Not this node's list: kept as they are.
      { id: "out", source: "make", sourceHandle: "out", target: "use", targetHandle: "item1" },
      into("other", "item2", "d"),
    ];
    const data = { count: 3, "default:item0": 1, "default:item1": 2, "default:item2": 3, title: "Make Array" };
    const result = removePinListEntry("array.make", "make", data, edges, 1);
    expect(result).toEqual({
      data: { count: 2, "default:item0": 1, "default:item1": 3, title: "Make Array" },
      edges: [
        into("make", "item0", "a"),
        { ...into("make", "item2", "c"), targetHandle: "item1" },
        edges[3],
        edges[4],
      ],
    });
  });

  it("removes a Make Map pair: its key and value wires and values go, later pairs move down", () => {
    const edges = [
      into("map", "key0", "k0"),
      into("map", "value0", "v0"),
      into("map", "key1", "k1"),
      into("map", "value2", "v2"),
    ];
    const data = { count: 3, "default:key0": "a", "default:value1": 5, "default:key2": "c", "default:value2": 7 };
    const result = removePinListEntry("map.make", "map", data, edges, 0);
    expect(result).toEqual({
      data: { count: 2, "default:value0": 5, "default:key1": "c", "default:value1": 7 },
      edges: [
        { ...into("map", "key1", "k1"), targetHandle: "key0" },
        { ...into("map", "value2", "v2"), targetHandle: "value1" },
      ],
    });
  });

  it("removes a Sequence output, renaming the later outputs' wires on the source side", () => {
    const edges = [
      { id: "in", source: "start", sourceHandle: "then", target: "seq", targetHandle: "execIn" },
      { id: "t0", source: "seq", sourceHandle: "then0", target: "a", targetHandle: "execIn" },
      { id: "t1", source: "seq", sourceHandle: "then1", target: "b", targetHandle: "execIn" },
      { id: "t2", source: "seq", sourceHandle: "then2", target: "c", targetHandle: "execIn" },
    ];
    const result = removePinListEntry("flow.sequence", "seq", { count: 3 }, edges, 0);
    expect(result).toEqual({
      data: { count: 2 },
      edges: [
        edges[0],
        { ...edges[2], sourceHandle: "then0" },
        { ...edges[3], sourceHandle: "then1" },
      ],
    });
  });

  it("removes the last entry, reading a missing count as the default", () => {
    // Sequence defaults to two outputs.
    const edges = [{ id: "t1", source: "seq", sourceHandle: "then1", target: "b", targetHandle: "execIn" }];
    expect(removePinListEntry("flow.sequence", "seq", {}, edges, 1)).toEqual({ data: { count: 1 }, edges: [] });
    // Make Array may reach zero items.
    expect(removePinListEntry("array.make", "make", { count: 1, "default:item0": 4 }, [], 0))
      .toEqual({ data: { count: 0 }, edges: [] });
  });

  it.each([
    ["at the minimum", "flow.sequence", { count: 1 }, 0],
    ["an empty Make Array", "array.make", { count: 0 }, 0],
    ["an index past the count", "array.make", { count: 2 }, 2],
    ["a negative index", "array.make", { count: 2 }, -1],
    ["a node without a growable list", "math.add", {}, 0],
  ])("is null for %s", (_label, typeId, data, index) => {
    expect(removePinListEntry(typeId, "n", data, [], index)).toBeNull();
  });
});

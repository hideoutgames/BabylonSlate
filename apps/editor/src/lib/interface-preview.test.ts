import { describe, expect, it } from "vitest";
import { interfacePreviewGraph } from "./interface-preview";

describe("interfacePreviewGraph", () => {
  it("builds a function node with exec pins and data pin directions", () => {
    const graph = interfacePreviewGraph({
      name: "OnHit",
      pins: [
        { name: "amount", typeId: "float", direction: "in" },
        { name: "killed", typeId: "bool", direction: "out" },
      ],
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.data.title).toBe("OnHit");
    const pins = graph.nodes[0]?.data.__pins as Array<{
      id: string;
      direction: string;
      name: string;
    }>;
    expect(pins.map((pin) => pin.id)).toEqual([
      "execIn",
      "execOut",
      "data-0",
      "data-1",
    ]);
    expect(pins.find((pin) => pin.name === "killed")?.direction).toBe("out");
    expect(graph.edges).toEqual([]);
  });
});

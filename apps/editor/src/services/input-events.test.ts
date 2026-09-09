import { describe, expect, it } from "vitest";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import {
  scriptPaletteNodes,
  hydrateSerializedGraphForEditor,
  materializeLogicGraph,
} from "./graph-validation";
import { variableDefaultPropertyRows } from "../lib/graph-inspector";

describe("input asset graph authoring", () => {
  const registry = createDefaultNodeRegistry();
  const inputAssets = [
    { guid: "jump", name: "Jump", type: "InputAction", valueType: "button" },
    { guid: "move", name: "Move", type: "InputAxis", valueType: "2d" },
  ];
  it("offers one typed event per asset on runtime event graphs and hides obsolete string nodes", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      inputAssets,
    });
    const events = nodes.filter((node) => node.nodeType === "input.event");
    expect(events.map((node) => node.title)).toEqual([
      "Event Jump",
      "Event Move",
    ]);
    expect(events[1]!.pins.find((pin) => pin.id === "value")?.type.kind).toBe(
      "vec2",
    );
    expect(nodes.some((node) => node.id === "input.onAction")).toBe(false);
    expect(
      scriptPaletteNodes(registry, {
        parentClass: "Actor",
        activeFunctionId: "fn",
        inputAssets,
      }).some((node) => node.nodeType === "input.event"),
    ).toBe(false);
  });
  it("refreshes the event title and value pins from asset identity rather than stale cached pins", () => {
    const graph = {
      nodes: [
        {
          id: "input",
          type: "input.event",
          position: { x: 0, y: 0 },
          data: {
            "default:input": { Name: "Old", Asset: "move" },
            valueType: "button",
            title: "Event Old",
            __pins: registry.get("input.event")!.pins({}),
          },
        },
      ],
      edges: [],
    };
    const hydrated = hydrateSerializedGraphForEditor(graph, registry, {
      inputAssets,
    });
    expect(hydrated.nodes[0]!.data.title).toBe("Event Move");
    const logic = materializeLogicGraph(hydrated, "g", "event", {
      inputAssets,
    });
    expect(
      logic.nodes[0]!.pins.find((pin) => pin.id === "value")?.type.kind,
    ).toBe("vec2");
  });
  it("uses an atomic asset dropdown for Input Type defaults", () => {
    let value: unknown;
    const rows = variableDefaultPropertyRows(
      "struct",
      {},
      (next) => {
        value = next;
      },
      {
        typeClassId: "engine:InputType",
        assetEntries: [
          { id: "jump", name: "Jump", type: "InputAction" },
          { id: "texture", name: "Texture", type: "Texture" },
        ],
      },
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    if (row.kind !== "enum") throw new Error("Expected input dropdown");
    expect(row.options.map((option) => option.value)).toEqual(["", "jump"]);
    row.onChange("jump");
    expect(value).toEqual({ Name: "Jump", Asset: "jump" });
  });
});

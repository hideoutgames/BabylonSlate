import { graphCompileSignature } from "./script-compiler";
import { describe, expect, it } from "vitest";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import {
  scriptPaletteNodes,
  hydrateSerializedGraphForEditor,
  materializeLogicGraph,
} from "./graph-validation";
import {
  inputEventPropertyRows,
  variableDefaultPropertyRows,
} from "../lib/graph-inspector";
import {
  collectGraphTypeAssets,
  typeSchemasFromGraphAssets,
} from "../lib/logic-graph-document";

describe("input asset graph authoring", () => {
  const registry = createDefaultNodeRegistry();
  const inputAssets = [
    { guid: "jump", name: "Jump", type: "InputAction", valueType: "button" },
    { guid: "move", name: "Move", type: "InputAxis", valueType: "2d" },
  ];
  it("offers generic and asset events in the same Input category only on runtime event graphs", () => {
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      inputAssets,
    });
    const events = nodes.filter(
      (node) =>
        node.nodeType === "input.actionEvent" ||
        node.nodeType === "input.axisEvent",
    );
    expect(events.map((node) => node.title)).toEqual([
      "Event Jump",
      "Event Move",
    ]);
    const generic = nodes.find((node) => node.id === "input.actionEvent")!;
    expect(generic.title).toBe("Event Input Action");
    expect(nodes.find((node) => node.id === "input.axisEvent")?.title).toBe(
      "Event Input Axis",
    );
    expect(events.every((event) => event.category === generic.category)).toBe(
      true,
    );
    expect(events[1]!.pins.find((pin) => pin.id === "value")?.type.kind).toBe(
      "vec2",
    );
    expect(
      nodes
        .find((node) => node.id === "input.onAnyKeyPressed")
        ?.pins.find((pin) => pin.id === "key")?.type,
    ).toEqual({ kind: "enumRef", guid: "engine:Key" });
    for (const options of [
      { activeFunctionId: "fn" },
      { parentClass: "FunctionLibrary" },
      { animationGraphHost: "rule" as const },
    ]) {
      expect(
        scriptPaletteNodes(registry, {
          parentClass: "Actor",
          inputAssets,
          ...options,
        }).some((node) =>
          [
            "input.actionEvent",
            "input.axisEvent",
            "input.onAnyKeyPressed",
          ].includes(node.nodeType ?? node.id),
        ),
      ).toBe(false);
    }
  });

  it("refreshes asset event titles and dimensions, then uses a generic title when its binding is wired", () => {
    const graph = {
      nodes: [
        {
          id: "event",
          type: "input.axisEvent",
          position: { x: 0, y: 0 },
          data: {
            "default:binding": { Input: { Name: "Old", Asset: "move" } },
            valueType: "1d",
            title: "Event Old",
            __pins: registry.get("input.axisEvent")!.pins({}),
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
    const wired = hydrateSerializedGraphForEditor(
      {
        ...hydrated,
        nodes: [
          ...hydrated.nodes,
          {
            id: "binding",
            type: "struct.make",
            position: { x: 0, y: 100 },
            data: { structGuid: "engine:InputBinding" },
          },
        ],
        edges: [
          {
            id: "wire",
            source: "binding",
            sourceHandle: "out",
            target: "event",
            targetHandle: "binding",
          },
        ],
      },
      registry,
      { inputAssets },
    );
    expect(wired.nodes[0]!.data.title).toBe("Event Input Axis");
    expect(wired.nodes[0]!.data.valueType).toBe("2d");
  });

  it("edits event assets through a filtered dropdown without a redundant default choice", () => {
    let patch: Record<string, unknown> = {};
    const assets = inputAssets.map((asset) => ({
      id: asset.guid,
      name: asset.name,
      type: asset.type,
    }));
    const rows = inputEventPropertyRows(
      "input.actionEvent",
      {},
      (next) => {
        patch = next;
      },
      assets,
      false,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    if (row.kind !== "enum") throw new Error("Expected input dropdown");
    expect(row.options.map((option) => option.value)).toEqual(["jump"]);
    row.onChange("jump");
    expect(patch).toEqual({
      "default:binding": { Input: { Name: "Jump", Asset: "jump" } },
    });
    expect(
      inputEventPropertyRows("input.actionEvent", {}, () => {}, assets, true),
    ).toEqual([]);
    const dimensions = inputEventPropertyRows(
      "input.axisEvent",
      {},
      (next) => {
        patch = next;
      },
      assets,
      true,
    )[0]!;
    if (dimensions.kind !== "enum") throw new Error("Expected dimensions");
    dimensions.onChange("2d");
    expect(patch).toEqual({ valueType: "2d" });
  });

  it("exposes Key and axis tuning when creating a local Input Binding", () => {
    const catalog = collectGraphTypeAssets({ assets: [], openDocuments: [] });
    const schemas = typeSchemasFromGraphAssets(catalog);
    const nodes = scriptPaletteNodes(registry, {
      parentClass: "Actor",
      structures: catalog.structures,
    });
    const make = nodes.find(
      (node) => node.id === "struct.make:engine:InputBinding",
    )!;
    expect(make.title).toBe("Make Input Binding");
    expect(make.pins.find((pin) => pin.id === "Key")?.type).toEqual({
      kind: "enumRef",
      guid: "engine:Key",
    });
    let value: unknown;
    const rows = variableDefaultPropertyRows(
      "struct",
      {},
      (next) => {
        value = next;
      },
      { typeClassId: "engine:InputBinding", schemas },
    );
    const key = rows.find((row) => row.label === "Key")!;
    if (key.kind !== "enum") throw new Error("Expected key dropdown");
    expect(key.options).toContainEqual({ value: "KeyW", label: "W" });
    expect(key.options).toContainEqual({
      value: "Gamepad1Button0",
      label: "Gamepad 1 Face Button Down",
    });
    key.onChange("KeyW");
    expect(value).toMatchObject({ Key: "KeyW", Scale: 1, DigitalValue: 1 });
  });
});

it("invalidates compiled graph signatures when an input asset changes dimensions or name", () => {
  const catalog = [
    { guid: "move", name: "Move", type: "InputAxis", valueType: "1d" },
  ];
  expect(graphCompileSignature([], catalog)).not.toBe(
    graphCompileSignature([], [{ ...catalog[0]!, valueType: "2d" }]),
  );
  expect(graphCompileSignature([], catalog)).not.toBe(
    graphCompileSignature([], [{ ...catalog[0]!, name: "Movement" }]),
  );
});

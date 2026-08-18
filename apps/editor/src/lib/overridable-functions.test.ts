import { describe, expect, it } from "vitest";
import { userInterfaceClassId } from "@babylonslate/core";
import {
  collectOverridableEventRows,
  collectOverridableFunctionRows,
} from "./overridable-functions";

describe("collectOverridableFunctionRows", () => {
  it("lists interface methods and parent overridable functions", () => {
    const rows = collectOverridableFunctionRows({
      classId: "Hero",
      parentOf: (id) => {
        if (id === "Hero") return "Pawn";
        if (id === "Pawn") return "Actor";
        return null;
      },
      graph: {
        nodes: [],
        edges: [],
        members: [
          { id: "if-1", kind: "interface", name: "Damageable", assetGuid: "iface-1" },
          { id: "fn-1", kind: "function", name: "Jump", pins: [] },
        ],
      },
      parentGraphs: {
        Pawn: {
          nodes: [],
          edges: [],
          members: [
            {
              id: "fn-p",
              kind: "function",
              name: "Jump",
              overridable: true,
              pins: [{ name: "height", typeId: "float", direction: "in" }],
            },
            { id: "fn-q", kind: "function", name: "Dash", pins: [] },
          ],
        },
      },
      scriptInterfaces: [
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
    });
    const iface = rows.find((row) => row.kind === "interface");
    expect(iface).toMatchObject({
      name: "Apply Damage",
      description: "Interface · Damageable",
      overwritten: false,
    });
    expect(iface?.pins.some((pin) => pin.typeId === "exec")).toBe(true);
    const jump = rows.find((row) => row.name === "Jump");
    expect(jump).toMatchObject({
      kind: "function",
      overwritten: true,
      description: "Parent · Pawn",
    });
    expect(rows.some((row) => row.name === "Dash")).toBe(false);
  });
});

describe("collectOverridableEventRows", () => {
  it("lists UserInterface native events including pointer events and greys ones already on the graph", () => {
    const rows = collectOverridableEventRows({
      assetType: "UserInterface",
      parentClass: "BObject",
      graph: {
        nodes: [
          {
            id: "begin",
            type: "flow.event.beginPlay",
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      },
    });
    expect(rows.find((row) => row.eventType === "flow.event.beginPlay")).toMatchObject(
      {
        kind: "native",
        name: "Event Begin Play",
        overwritten: true,
      },
    );
    expect(rows.find((row) => row.eventType === "flow.event.tick")?.overwritten).toBe(
      false,
    );
    expect(rows.some((row) => row.eventType === "flow.event.mouseEnter")).toBe(
      true,
    );
    expect(rows.some((row) => row.eventType === "flow.event.widgetClick")).toBe(
      true,
    );
    expect(rows.some((row) => row.eventType === "flow.event.editorBeginPlay")).toBe(
      false,
    );
  });

  it("lists EditorUtilityInterface editor begin play and pointer events without Tick", () => {
    const rows = collectOverridableEventRows({
      assetType: "EditorUtilityInterface",
      parentClass: "BObject",
      graph: { nodes: [], edges: [] },
    });
    expect(rows.map((row) => row.eventType)).toEqual(
      expect.arrayContaining([
        "flow.event.editorBeginPlay",
        "flow.event.mouseEnter",
        "flow.event.mouseExit",
        "flow.event.mousePress",
        "flow.event.mouseRelease",
        "flow.event.widgetClick",
      ]),
    );
    expect(rows.some((row) => row.eventType === "flow.event.tick")).toBe(false);
    expect(rows.some((row) => row.eventType === "flow.event.beginPlay")).toBe(
      false,
    );
  });

  it("lists parent custom events as overridable inherited rows", () => {
    const rows = collectOverridableEventRows({
      classId: "Hero",
      parentClass: "Pawn",
      parentOf: (id) => {
        if (id === "Hero") return "Pawn";
        if (id === "Pawn") return "Actor";
        return null;
      },
      graph: { nodes: [], edges: [] },
      parentGraphs: {
        Pawn: {
          nodes: [
            {
              id: "p",
              type: "flow.event.custom",
              position: { x: 0, y: 0 },
              data: { name: "On Hit" },
            },
          ],
          edges: [],
        },
      },
    });
    expect(rows.find((row) => row.name === "On Hit")).toMatchObject({
      kind: "parent",
      description: "Parent · Pawn",
      overwritten: false,
      eventType: "flow.event.custom",
      parentClassId: "Pawn",
    });
  });

  it("lists nested UserInterface custom events and greys host overrides", () => {
    const rows = collectOverridableEventRows({
      assetType: "UserInterface",
      parentClass: "BObject",
      graph: {
        nodes: [
          {
            id: "e1",
            type: "flow.event.custom",
            position: { x: 0, y: 0 },
            data: { name: "On Host Hit" },
          },
        ],
        edges: [],
      },
      nestedUis: [
        {
          guid: "chip-guid",
          name: "Chip",
          graph: {
            nodes: [
              {
                id: "n",
                type: "flow.event.custom",
                position: { x: 0, y: 0 },
                data: { name: "On Chip" },
              },
              {
                id: "h",
                type: "flow.event.custom",
                position: { x: 0, y: 0 },
                data: { name: "On Host Hit" },
              },
            ],
            edges: [],
          },
        },
      ],
    });
    expect(rows.find((row) => row.name === "On Chip")).toMatchObject({
      kind: "nested",
      description: "Nested · Chip",
      overwritten: false,
      parentClassId: userInterfaceClassId("chip-guid"),
    });
    expect(
      rows.find((row) => row.kind === "nested" && row.name === "On Host Hit")
        ?.overwritten,
    ).toBe(true);
  });
});

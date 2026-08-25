import { describe, expect, it } from "vitest";
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
  it("does not list leftover EditorUtilityInterface editor events as overridable", () => {
    const rows = collectOverridableEventRows({
      assetType: "EditorUtilityInterface",
      parentClass: "BObject",
      graph: { nodes: [], edges: [] },
    });
    expect(rows.some((row) => row.eventType === "flow.event.editorBeginPlay")).toBe(
      false,
    );
    expect(rows.some((row) => row.eventType === "flow.event.mouseEnter")).toBe(
      false,
    );
    expect(rows.some((row) => row.eventType === "flow.event.tick")).toBe(false);
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

  it("lists Actor native events including On Actor Destroyed and greys ones already on the graph", () => {
    const rows = collectOverridableEventRows({
      classId: "Hero",
      parentClass: "Actor",
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
    expect(rows.find((row) => row.eventType === "flow.event.tick")).toMatchObject({
      kind: "native",
      name: "Event Tick",
      overwritten: false,
    });
    expect(rows.find((row) => row.eventType === "flow.event.destroyed")).toMatchObject(
      {
        kind: "native",
        name: "Event On Actor Destroyed",
        overwritten: false,
      },
    );
    expect(rows.some((row) => row.eventType === "flow.event.mouseEnter")).toBe(
      false,
    );
  });

  it("does not list a deleted local custom event as overridable on the declaring class", () => {
    const rows = collectOverridableEventRows({
      classId: "Hero",
      parentClass: "Actor",
      graph: { nodes: [], edges: [] },
    });
    expect(rows.some((row) => row.name === "On Hit")).toBe(false);
  });

  it("still lists a parent custom event after the child deletes its override node", () => {
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
          members: [{ id: "p", kind: "event", name: "On Hit" }],
        },
      },
    });
    expect(rows.find((row) => row.name === "On Hit")).toMatchObject({
      kind: "parent",
      overwritten: false,
    });
  });
});

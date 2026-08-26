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

  it("does not list overlay mouse events until a 2D Button is attached", () => {
    const empty = collectOverridableEventRows({
      classId: "Hud",
      parentClass: "SceneLayerActor",
      graph: { nodes: [], edges: [], components: [] },
    });
    expect(empty.some((row) => row.eventType === "flow.event.onClick")).toBe(
      false,
    );
    expect(
      empty.find((row) => row.eventType === "flow.event.beginPlay")
        ?.eventQualifier,
    ).toBeUndefined();

    const withButton = collectOverridableEventRows({
      classId: "Hud",
      parentClass: "SceneLayerActor",
      graph: {
        nodes: [],
        edges: [],
        components: [
          {
            id: "btn-1",
            classId: "2DButtonComponent",
            properties: {},
          },
        ],
      },
    });
    const click = withButton.find(
      (row) =>
        row.eventType === "flow.event.onClick" && row.componentId === "btn-1",
    );
    expect(click).toMatchObject({
      kind: "component",
      name: "Event On Click",
      eventQualifier: "2D Button",
      overwritten: false,
    });
  });

  it("lists one On Click row per attached 2D Button", () => {
    const rows = collectOverridableEventRows({
      classId: "Hud",
      parentClass: "SceneLayerActor",
      graph: {
        nodes: [
          {
            id: "click-1",
            type: "flow.event.onClick",
            position: { x: 0, y: 0 },
            data: { componentId: "btn-1" },
          },
        ],
        edges: [],
        components: [
          { id: "btn-1", classId: "2DButtonComponent", properties: {} },
          { id: "btn-2", classId: "2DButtonComponent", properties: {} },
        ],
      },
    });
    const clicks = rows.filter((row) => row.eventType === "flow.event.onClick");
    expect(clicks).toEqual([
      expect.objectContaining({
        componentId: "btn-1",
        eventQualifier: "2D Button",
        overwritten: true,
      }),
      expect.objectContaining({
        componentId: "btn-2",
        eventQualifier: "2D Button 2",
        overwritten: false,
      }),
    ]);
  });

  it("lists overlap events only when a collider is attached", () => {
    const without = collectOverridableEventRows({
      classId: "Hero",
      parentClass: "Actor",
      graph: { nodes: [], edges: [], components: [] },
    });
    expect(
      without.some((row) => row.eventType === "flow.event.beginOverlap"),
    ).toBe(false);

    const withCollider = collectOverridableEventRows({
      classId: "Hero",
      parentClass: "Actor",
      graph: {
        nodes: [],
        edges: [],
        components: [
          { id: "col-1", classId: "ColliderComponent", properties: {} },
        ],
      },
    });
    expect(
      withCollider.find(
        (row) =>
          row.eventType === "flow.event.beginOverlap" &&
          row.componentId === "col-1",
      ),
    ).toMatchObject({
      kind: "component",
      eventQualifier: "Collider",
    });
  });

  it("lists On Text Changed once per attached 3D Text", () => {
    const rows = collectOverridableEventRows({
      classId: "Hero",
      parentClass: "Actor",
      graph: {
        nodes: [],
        edges: [],
        components: [
          { id: "text-a", classId: "Text3DComponent", properties: {} },
          { id: "text-b", classId: "Text3DComponent", properties: {} },
        ],
      },
    });
    const changed = rows.filter(
      (row) => row.eventType === "flow.event.textChanged",
    );
    expect(changed).toEqual([
      expect.objectContaining({
        componentId: "text-a",
        eventQualifier: "3D Text",
      }),
      expect.objectContaining({
        componentId: "text-b",
        eventQualifier: "3D Text 2",
      }),
    ]);
  });

  it("lists custom events from an attached user component class", () => {
    const rows = collectOverridableEventRows({
      classId: "Hero",
      parentClass: "Actor",
      graph: {
        nodes: [],
        edges: [],
        components: [
          { id: "comp-1", classId: "HealthComponent", properties: {} },
        ],
      },
      parentGraphs: {
        HealthComponent: {
          nodes: [
            {
              id: "e",
              type: "flow.event.custom",
              position: { x: 0, y: 0 },
              data: { name: "On Damaged" },
            },
          ],
          edges: [],
        },
      },
    });
    expect(
      rows.find(
        (row) => row.name === "On Damaged" && row.componentId === "comp-1",
      ),
    ).toMatchObject({
      kind: "component",
      eventType: "flow.event.custom",
      eventQualifier: "Health Component",
    });
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

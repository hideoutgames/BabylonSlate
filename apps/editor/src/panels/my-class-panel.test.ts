import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { ensureEventNodeOnGraph } from "../lib/class-members";
import {
  blueprintTreeNodes,
  membersForGraph,
  membersForSection,
} from "./my-class-panel";

describe("My Class members", () => {
  it("Title Cases poorly cased event titles in the Class tree", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "hit",
          type: "flow.event.custom",
          position: { x: 0, y: 0 },
          data: { title: "event on hit", name: "on hit" },
        },
      ],
      edges: [],
    };
    expect(membersForGraph(graph)).toEqual([
      {
        kind: "event",
        name: "Event Begin Play",
        detail: "native:flow.event.beginPlay",
        eventType: "flow.event.beginPlay",
      },
      {
        kind: "event",
        name: "Event Tick",
        detail: "native:flow.event.tick",
        eventType: "flow.event.tick",
      },
      {
        kind: "event",
        name: "On Hit",
        detail: "hit",
        eventType: "flow.event.custom",
      },
    ]);
  });

  it("lists the event nodes a graph declares", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "tick",
          type: "flow.event.tick",
          position: { x: 0, y: 120 },
          data: {},
        },
        {
          id: "log",
          type: "debug.log",
          position: { x: 200, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    expect(membersForGraph(graph)).toEqual([
      {
        kind: "event",
        name: "Event Begin Play",
        detail: "begin",
        eventType: "flow.event.beginPlay",
      },
      {
        kind: "event",
        name: "Event Tick",
        detail: "tick",
        eventType: "flow.event.tick",
      },
    ]);
  });

  it("still lists native Begin Play and Tick stubs when the graph has no event nodes", () => {
    expect(membersForGraph({ nodes: [], edges: [] })).toEqual([
      {
        kind: "event",
        name: "Event Begin Play",
        detail: "native:flow.event.beginPlay",
        eventType: "flow.event.beginPlay",
      },
      {
        kind: "event",
        name: "Event Tick",
        detail: "native:flow.event.tick",
        eventType: "flow.event.tick",
      },
    ]);
    expect(membersForGraph(null)).toEqual([]);
  });

  it("does not list Call Custom Event canvas nodes as Class events", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "hit",
          type: "flow.event.custom",
          position: { x: 0, y: 0 },
          data: { name: "On Hit", title: "Event On Hit" },
        },
        {
          id: "call",
          type: "flow.event.call",
          position: { x: 200, y: 0 },
          data: {
            title: "Call On Hit",
            name: "On Hit",
            classId: "Hero",
            implicitSelf: true,
          },
        },
      ],
      edges: [],
    };
    const events = membersForSection(membersForGraph(graph), "event");
    expect(events.filter((row) => row.eventType === "flow.event.call")).toEqual(
      [],
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "flow.event.custom",
          name: "On Hit",
          detail: "hit",
        }),
      ]),
    );
  });

  it("does not list Call Parent canvas nodes as Class events", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: { title: "Event Begin Play" },
        },
        {
          id: "call-parent",
          type: "flow.event.callParent",
          position: { x: 280, y: 0 },
          data: {
            title: "Call Begin Play Parent",
            eventType: "flow.event.beginPlay",
            parentClassId: "Actor",
          },
        },
      ],
      edges: [],
    };
    const events = membersForSection(membersForGraph(graph), "event");
    expect(
      events.filter((row) => row.eventType === "flow.event.callParent"),
    ).toEqual([]);
    expect(events.some((row) => row.name.includes("Call"))).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "flow.event.beginPlay",
          name: "Event Begin Play",
          detail: "begin",
        }),
      ]),
    );
  });

  it("does not list Call Parent after placing a missing parent event stub", () => {
    const next = ensureEventNodeOnGraph(
      { nodes: [], edges: [] },
      "flow.event.beginPlay",
      { parentClassId: "Actor", idFactory: () => "evt-1" },
    );
    expect(next.nodes.some((node) => node.type === "flow.event.callParent")).toBe(
      true,
    );
    const events = membersForSection(membersForGraph(next), "event");
    expect(
      events.filter((row) => row.eventType === "flow.event.callParent"),
    ).toEqual([]);
    expect(events.map((row) => row.eventType).sort()).toEqual([
      "flow.event.beginPlay",
      "flow.event.tick",
    ]);
  });

  it("lists no native Actor events for a BObject class", () => {
    expect(
      membersForGraph({ nodes: [], edges: [] }, { parentClass: "BObject" }),
    ).toEqual([]);
  });

  it("lists On Evaluate instead of Begin Play for a BTDecorator class", () => {
    expect(
      membersForGraph({ nodes: [], edges: [] }, { parentClass: "BTDecorator" }),
    ).toEqual([
      {
        kind: "event",
        name: "On Evaluate",
        detail: "native:bt.event.evaluate",
        eventType: "bt.event.evaluate",
      },
    ]);
  });

  it("marks parent Class custom events as inherited", () => {
    const members = membersForGraph(
      { nodes: [], edges: [] },
      {
        parentClass: "HeroBase",
        parentGraphs: {
          HeroBase: {
            nodes: [
              {
                id: "hit",
                type: "flow.event.custom",
                position: { x: 0, y: 0 },
                data: { name: "On Hit", title: "Event On Hit" },
              },
            ],
            edges: [],
            members: [
              {
                id: "var-1",
                kind: "variable",
                name: "Health",
                typeId: "float",
              },
              {
                id: "fn-1",
                kind: "function",
                name: "Jump",
                pins: [],
              },
            ],
          },
        },
      },
    );
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          name: "On Hit",
          inherited: true,
          inheritedFrom: "HeroBase",
        }),
        expect.objectContaining({
          kind: "variable",
          name: "Health",
          inherited: true,
          inheritedFrom: "HeroBase",
        }),
        expect.objectContaining({
          kind: "function",
          name: "Jump",
          inherited: true,
          inheritedFrom: "HeroBase",
        }),
      ]),
    );
    const tree = blueprintTreeNodes(members, new Set(), {
      parentClass: "HeroBase",
    });
    const health = tree.find((row) => row.label === "Health");
    expect(health?.trailing).toBeTruthy();
  });

  it("does not list parent Call Parent nodes as inherited events", () => {
    const members = membersForGraph(
      { nodes: [], edges: [] },
      {
        parentClass: "HeroBase",
        parentGraphs: {
          HeroBase: {
            nodes: [
              {
                id: "hit",
                type: "flow.event.custom",
                position: { x: 0, y: 0 },
                data: { name: "On Hit", title: "Event On Hit" },
              },
              {
                id: "call-parent",
                type: "flow.event.callParent",
                position: { x: 280, y: 0 },
                data: {
                  title: "Call On Hit Parent",
                  eventType: "flow.event.custom",
                  eventName: "On Hit",
                  parentClassId: "Actor",
                },
              },
            ],
            edges: [],
          },
        },
      },
    );
    const events = membersForSection(members, "event");
    expect(
      events.filter((row) => row.eventType === "flow.event.callParent"),
    ).toEqual([]);
    expect(events.some((row) => row.name.includes("Call"))).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          name: "On Hit",
          inherited: true,
          inheritedFrom: "HeroBase",
        }),
      ]),
    );
  });

  it("places event members under Events and leaves other sections empty", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const members = membersForGraph(graph);
    expect(membersForSection(members, "event")).toEqual([
      {
        kind: "event",
        name: "Event Begin Play",
        detail: "begin",
        eventType: "flow.event.beginPlay",
      },
      {
        kind: "event",
        name: "Event Tick",
        detail: "native:flow.event.tick",
        eventType: "flow.event.tick",
      },
    ]);
    expect(membersForSection(members, "function")).toEqual([]);
    expect(membersForSection(members, "variable")).toEqual([]);
    expect(membersForSection(members, "interface")).toEqual([]);
    expect(membersForSection(members, null)).toEqual([]);
  });

  it("builds a compact section tree with Events populated and no Graphs section", () => {
    const members = membersForGraph({
      nodes: [
        {
          id: "begin",
          type: "flow.event.beginPlay",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    });
    const rows = blueprintTreeNodes(members, new Set());
    expect(rows.map((row) => row.id)).toEqual([
      "section-functions",
      "section-variables",
      "section-events",
      "begin",
      "native:flow.event.tick",
      "section-interfaces",
    ]);
    expect(rows.find((row) => row.id === "begin")?.label).toBe(
      "Event Begin Play",
    );
  });

  it("lists persisted functions, variables, and interfaces from graph members", () => {
    const graph: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [
        { id: "fn-1", kind: "function", name: "Jump" },
        { id: "var-1", kind: "variable", name: "Health" },
        { id: "if-1", kind: "interface", name: "Damageable" },
      ],
    };
    const members = membersForGraph(graph);
    expect(membersForSection(members, "function")).toEqual([
      { kind: "function", name: "Jump", detail: "fn-1" },
    ]);
    expect(membersForSection(members, "variable")).toEqual([
      { kind: "variable", name: "Health", detail: "var-1" },
    ]);
    expect(membersForSection(members, "interface")).toEqual([
      { kind: "interface", name: "Damageable", detail: "if-1" },
    ]);
  });

  it("exposes variable typeId for pin color in the tree", () => {
    const members = membersForGraph({
      nodes: [],
      edges: [],
      members: [{ id: "var-1", kind: "variable", name: "Health", typeId: "bool" }],
    });
    expect(members.find((member) => member.kind === "variable")?.typeId).toBe(
      "bool",
    );
  });

  it("keeps function-local variables out of the Variables section", () => {
    const graph: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [
        { id: "fn-1", kind: "function", name: "Jump" },
        { id: "var-1", kind: "variable", name: "Health", typeId: "float" },
        {
          id: "loc-1",
          kind: "variable",
          name: "Temp",
          typeId: "int",
          functionId: "fn-1",
        },
      ],
    };
    const members = membersForGraph(graph);
    expect(membersForSection(members, "variable")).toEqual([
      { kind: "variable", name: "Health", detail: "var-1", typeId: "float" },
      {
        kind: "variable",
        name: "Temp",
        detail: "loc-1",
        typeId: "int",
        functionId: "fn-1",
      },
    ]);
    const eventRows = blueprintTreeNodes(members, new Set());
    expect(eventRows.map((row) => row.id)).not.toContain("section-local-variables");
    expect(eventRows.map((row) => row.id)).not.toContain("loc-1");
    expect(eventRows.map((row) => row.id)).toContain("var-1");
    const functionRows = blueprintTreeNodes(members, new Set(), {
      activeFunctionId: "fn-1",
    });
    expect(functionRows.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        "section-variables",
        "var-1",
        "section-local-variables",
        "loc-1",
      ]),
    );
    const localIndex = functionRows.findIndex(
      (row) => row.id === "section-local-variables",
    );
    expect(functionRows[localIndex]?.label).toBe("Local Variables");
  });
});

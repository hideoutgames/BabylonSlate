import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
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

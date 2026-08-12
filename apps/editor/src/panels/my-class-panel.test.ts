import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  blueprintTreeNodes,
  membersForGraph,
  membersForSection,
} from "./my-class-panel";

describe("My Class members", () => {
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
      { kind: "event", name: "Event Begin Play", detail: "begin" },
      { kind: "event", name: "Event Tick", detail: "tick" },
    ]);
  });

  it("reports nothing for a graph with no events", () => {
    expect(membersForGraph({ nodes: [], edges: [] })).toEqual([]);
    expect(membersForGraph(null)).toEqual([]);
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
      { kind: "event", name: "Event Begin Play", detail: "begin" },
    ]);
    expect(membersForSection(members, "function")).toEqual([]);
    expect(membersForSection(members, "variable")).toEqual([]);
    expect(membersForSection(members, "interface")).toEqual([]);
    expect(membersForSection(members, null)).toEqual([]);
  });

  it("builds a compact section tree with Events populated", () => {
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
      "section-graphs",
      "section-functions",
      "section-variables",
      "section-events",
      "begin",
      "section-interfaces",
    ]);
    expect(rows.find((row) => row.id === "begin")?.label).toBe(
      "Event Begin Play",
    );
  });
});

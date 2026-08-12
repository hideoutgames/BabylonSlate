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
      { kind: "event", name: "Event On Hit", detail: "hit" },
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
});

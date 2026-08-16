import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  replaceSerializedGraphInDocument,
  serializedGraphFromDocument,
} from "./logic-graph-document";

const graph: SerializedGraph = {
  nodes: [{ id: "n1", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} }],
  edges: [],
  members: [{ id: "fn-1", kind: "function", name: "Jump" }],
};

describe("serializedGraphFromDocument", () => {
  it("reads a Class document body as the logic graph", () => {
    expect(serializedGraphFromDocument("graph", graph)).toEqual(graph);
  });

  it("reads UserInterface payload.logic", () => {
    expect(
      serializedGraphFromDocument("ui", { rootId: "canvas", logic: graph }),
    ).toEqual(graph);
  });

  it("returns null when UI payload has no logic graph", () => {
    expect(serializedGraphFromDocument("ui", { rootId: "canvas" })).toBeNull();
    expect(serializedGraphFromDocument("scene", { actors: [] })).toBeNull();
  });
});

describe("replaceSerializedGraphInDocument", () => {
  it("replaces a Class document body", () => {
    const next: SerializedGraph = { nodes: [], edges: [], members: [] };
    expect(replaceSerializedGraphInDocument("graph", graph, next)).toEqual(next);
  });

  it("merges logic back into a UserInterface payload without dropping widgets", () => {
    const next: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [{ id: "fn-1", kind: "function", name: "Jump" }],
    };
    expect(
      replaceSerializedGraphInDocument(
        "ui",
        { rootId: "canvas", widgets: { canvas: { id: "canvas" } }, logic: graph },
        next,
      ),
    ).toEqual({
      rootId: "canvas",
      widgets: { canvas: { id: "canvas" } },
      logic: next,
    });
  });
});

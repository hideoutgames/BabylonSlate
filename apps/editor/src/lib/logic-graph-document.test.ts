import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  collectFunctionLibrariesForPalette,
  commitLogicGraph,
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

describe("collectFunctionLibrariesForPalette", () => {
  const parentOf = (id: string) => {
    if (id === "MathLib") return "FunctionLibrary";
    if (id === "FunctionLibrary") return "BObject";
    if (id === "EditorMath") return "EditorFunctionLibrary";
    if (id === "EditorFunctionLibrary") return "FunctionLibrary";
    if (id === "Hero") return "Actor";
    return null;
  };

  it("reads header functions for closed libraries and live members for open ones", () => {
    const libraries = collectFunctionLibrariesForPalette({
      assets: [
        {
          path: "assets/MathLib.class.babasset",
          header: {
            type: "Class",
            name: "MathLib",
            parentClass: "FunctionLibrary",
            payload: {
              functions: [
                {
                  name: "Add",
                  pins: [
                    { name: "a", typeId: "float", direction: "in" },
                    {
                      name: "pawn",
                      typeId: "object",
                      direction: "in",
                      typeClassId: "Pawn",
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          path: "assets/EditorMath.class.babasset",
          header: {
            type: "Class",
            name: "EditorMath",
            parentClass: "EditorFunctionLibrary",
            payload: { functions: [{ name: "Stale", pins: [] }] },
          },
        },
        {
          path: "assets/Hero.class.babasset",
          header: {
            type: "Class",
            name: "Hero",
            parentClass: "Actor",
            payload: {},
          },
        },
      ],
      openDocuments: [
        {
          ref: { kind: "graph", path: "assets/EditorMath.class.babasset" },
          content: {
            nodes: [],
            edges: [],
            members: [{ id: "fn-1", kind: "function", name: "Snap", pins: [] }],
          },
        },
      ],
      parentOf,
      classIdForPath: (path) =>
        path.includes("MathLib")
          ? "MathLib"
          : path.includes("EditorMath")
            ? "EditorMath"
            : "Hero",
    });
    expect(libraries).toEqual([
      {
        classId: "MathLib",
        parentClass: "FunctionLibrary",
        functions: [
          {
            name: "Add",
            pins: [
              { name: "a", typeId: "float", direction: "in" },
              {
                name: "pawn",
                typeId: "object",
                direction: "in",
                typeClassId: "Pawn",
              },
            ],
          },
        ],
      },
      {
        classId: "EditorMath",
        parentClass: "EditorFunctionLibrary",
        functions: [{ name: "Snap", pins: [] }],
      },
    ]);
  });
});

describe("commitLogicGraph", () => {
  it("returns a Class graph commit", () => {
    const next: SerializedGraph = { nodes: [], edges: [], members: [] };
    expect(commitLogicGraph("graph", graph, next)).toEqual({
      kind: "graph",
      graph: next,
    });
  });

  it("returns a UserInterface payload commit that keeps widgets", () => {
    const next: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [{ id: "fn-1", kind: "function", name: "Dash" }],
    };
    expect(
      commitLogicGraph(
        "ui",
        { rootId: "canvas", widgets: { canvas: { id: "canvas" } }, logic: graph },
        next,
      ),
    ).toEqual({
      kind: "ui",
      payload: {
        rootId: "canvas",
        widgets: { canvas: { id: "canvas" } },
        logic: next,
      },
    });
  });

  it("seeds payload.logic when a UserInterface document has none yet", () => {
    const next: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [{ id: "fn-1", kind: "function", name: "Dash" }],
    };
    expect(
      commitLogicGraph("ui", { rootId: "canvas", widgets: {} }, next),
    ).toEqual({
      kind: "ui",
      payload: { rootId: "canvas", widgets: {}, logic: next },
    });
  });
});

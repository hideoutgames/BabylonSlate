import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  classGraphFromHeaderPayload,
  collectClassGraphsForPalette,
  collectFunctionLibrariesForPalette,
  collectGraphTypeAssets,
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

  it("returns null for non-logic document kinds", () => {
    expect(serializedGraphFromDocument("scene", { actors: [] })).toBeNull();
  });

  it("reads Animation Object graphs and injects variable members", () => {
    const doc = createDefaultAnimGraph();
    doc.variables = [
      { id: "var-moving", name: "moving", typeId: "bool", defaultValue: false },
    ];
    const graph = serializedGraphFromDocument("anim-graph", doc);
    expect(graph?.nodes.some((node) => node.type === "anim.event.initialize")).toBe(
      true,
    );
    expect(graph?.members).toEqual([
      {
        id: "var-moving",
        kind: "variable",
        name: "moving",
        typeId: "bool",
        defaultValue: false,
      },
    ]);
  });
});

describe("replaceSerializedGraphInDocument", () => {
  it("replaces a Class document body", () => {
    const next: SerializedGraph = { nodes: [], edges: [], members: [] };
    expect(replaceSerializedGraphInDocument("graph", graph, next)).toEqual(next);
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

describe("collectClassGraphsForPalette", () => {
  it("rebuilds members from a closed Class header and prefers open documents", () => {
    expect(
      classGraphFromHeaderPayload({
        functions: [
          {
            id: "fn-1",
            name: "Alert",
            pins: [
              { name: "exec", typeId: "exec", direction: "in" },
              {
                name: "target",
                typeId: "object",
                direction: "in",
                typeClassId: "Hero",
              },
            ],
          },
        ],
        variables: [
          { id: "var-1", name: "Health", typeId: "float" },
          { id: "var-2", name: "Pawn", typeId: "object", typeClassId: "Actor" },
        ],
        events: [{ id: "evt-1", name: "On Hit", pins: [] }],
      }).members,
    ).toEqual([
      {
        id: "fn-1",
        kind: "function",
        name: "Alert",
        pins: [
          { name: "exec", typeId: "exec", direction: "in" },
          {
            name: "target",
            typeId: "object",
            direction: "in",
            typeClassId: "Hero",
          },
        ],
      },
      { id: "var-1", kind: "variable", name: "Health", typeId: "float" },
      {
        id: "var-2",
        kind: "variable",
        name: "Pawn",
        typeId: "object",
        typeClassId: "Actor",
      },
      { id: "evt-1", kind: "event", name: "On Hit", pins: [] },
    ]);

    const graphs = collectClassGraphsForPalette({
      assets: [
        {
          path: "assets/Guard.class.babasset",
          header: {
            type: "Class",
            name: "Guard",
            parentClass: "Actor",
            payload: {
              functions: [{ id: "fn-1", name: "Alert", pins: [] }],
              variables: [{ id: "var-1", name: "Health", typeId: "float" }],
              events: [{ id: "evt-1", name: "On Alert", pins: [] }],
            },
          },
        },
        {
          path: "assets/Hero.class.babasset",
          header: {
            type: "Class",
            name: "Hero",
            parentClass: "Actor",
            payload: {
              functions: [{ id: "stale", name: "Stale", pins: [] }],
            },
          },
        },
      ],
      openDocuments: [
        {
          ref: { kind: "graph", path: "assets/Hero.class.babasset" },
          content: {
            nodes: [],
            edges: [],
            members: [{ id: "fn-live", kind: "function", name: "Jump", pins: [] }],
          },
        },
      ],
      classIdForPath: (path) =>
        path.includes("Guard") ? "Guard" : "Hero",
    });
    expect(graphs.Guard?.members).toEqual([
      { id: "fn-1", kind: "function", name: "Alert", pins: [] },
      { id: "var-1", kind: "variable", name: "Health", typeId: "float" },
      { id: "evt-1", kind: "event", name: "On Alert", pins: [] },
    ]);
    expect(graphs.Hero?.members).toEqual([
      { id: "fn-live", kind: "function", name: "Jump", pins: [] },
    ]);
  });

  it("does not treat an open Animation Graph as a Class palette graph", () => {
    const graphs = collectClassGraphsForPalette({
      assets: [],
      openDocuments: [
        {
          ref: { kind: "anim-graph", path: "assets/Loco.anim.babasset" },
          content: createDefaultAnimGraph(),
        },
      ],
      classIdForPath: () => "Loco_anim",
    });
    expect(graphs).toEqual({});
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

  it("drops custom event members whose canvas nodes were deleted", () => {
    const next: SerializedGraph = {
      nodes: [],
      edges: [],
      members: [
        { id: "evt-1", kind: "event", name: "On Hit" },
        { id: "fn-1", kind: "function", name: "Jump" },
      ],
    };
    expect(commitLogicGraph("graph", graph, next)).toEqual({
      kind: "graph",
      graph: {
        nodes: [],
        edges: [],
        members: [{ id: "fn-1", kind: "function", name: "Jump" }],
      },
    });
  });

  it("writes Animation Object graphs without dropping states", () => {
    const doc = createDefaultAnimGraph();
    const next: SerializedGraph = {
      nodes: [
        {
          id: "event-initialize",
          type: "anim.event.initialize",
          position: { x: 40, y: 40 },
          data: { title: "Event Initialize Animation" },
        },
      ],
      edges: [],
      members: [{ id: "var-speed", kind: "variable", name: "speed", typeId: "float" }],
    };
    const commit = commitLogicGraph("anim-graph", doc, next);
    expect(commit.kind).toBe("anim-graph");
    if (commit.kind !== "anim-graph") return;
    expect(commit.payload.states).toEqual(doc.states);
    expect(commit.payload.animationObject).toEqual({
      nodes: next.nodes,
      edges: next.edges,
    });
  });
});

describe("collectGraphTypeAssets", () => {
  it("merges Structure and Enum assets with open documents", () => {
    const catalog = collectGraphTypeAssets({
      assets: [
        {
          header: {
            type: "Structure",
            guid: "struct-stats",
            name: "Stats",
            payload: {
              guid: "struct-stats",
              name: "Stats",
              fields: [{ name: "Health", typeId: "int" }],
            },
          },
        },
        {
          header: {
            type: "Enum",
            guid: "enum-team",
            name: "Team",
            payload: {
              guid: "enum-team",
              members: [{ name: "None", value: 0 }],
            },
          },
        },
      ],
      openDocuments: [
        {
          ref: { kind: "enum" },
          content: {
            kind: "enum",
            guid: "enum-team",
            name: "Team",
            members: [
              { name: "Red", value: 1 },
              { name: "Blue", value: 2 },
            ],
          },
        },
      ],
    });
    expect(catalog.structures).toEqual([
      {
        guid: "engine:HitResult",
        name: "Hit Result",
        fields: [
          { name: "Hit", typeId: "bool" },
          { name: "Location", typeId: "vec3" },
          { name: "Normal", typeId: "vec3" },
          { name: "Actor", typeId: "actor" },
          { name: "Distance", typeId: "float" },
        ],
      },
      {
        guid: "struct-stats",
        name: "Stats",
        fields: [{ name: "Health", typeId: "int" }],
      },
    ]);
    expect(catalog.enums).toEqual([
      {
        guid: "engine:InputMode",
        name: "Input Mode",
        members: [
          { name: "All", value: 0 },
          { name: "Interface", value: 1 },
          { name: "Game", value: 2 },
        ],
      },
      {
        guid: "engine:CollisionChannel",
        name: "Collision Channel",
        members: [
          { name: "All", value: 0 },
          { name: "WorldStatic", value: 1 },
          { name: "WorldDynamic", value: 2 },
          { name: "Pawn", value: 3 },
          { name: "Visibility", value: 4 },
        ],
      },
      {
        guid: "enum-team",
        name: "Team",
        members: [
          { name: "Red", value: 1 },
          { name: "Blue", value: 2 },
        ],
      },
    ]);
  });
});

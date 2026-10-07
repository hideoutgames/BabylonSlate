import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import { DocumentEditStack, SetAssetDocumentCommand } from "@babylonslate/edit";
import {
  classGraphFromHeaderPayload,
  collectClassGraphsForPalette,
  collectFunctionLibrariesForPalette,
  collectGraphTypeAssets,
  typeSchemasFromGraphAssets,
  collectSceneDocumentsForPalette,
  collectSubsystemClassesForPalette,
  commitLogicGraph,
  replaceSerializedGraphInDocument,
  serializedGraphFromDocument,
} from "./logic-graph-document";
import { classParentLookup } from "./content-browser-helpers";
import { classIdForGraphPath } from "../services/script-compiler";

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

describe("collectSubsystemClassesForPalette", () => {
  it("lists every project and plugin subsystem class by compile id with its base", () => {
    const assets = [
      { path: "assets/Rain-Weather.class.babasset", header: { type: "Class", name: "Rain-Weather", parentClass: "Weather" } },
      { path: "assets/Weather.class.babasset", header: { type: "Class", name: "Weather", parentClass: "SceneSubsystem" } },
      { path: "assets/Save.class.babasset", header: { type: "Class", name: "Save", parentClass: "GameSubsystem" } },
      { path: "assets/Hero.class.babasset", header: { type: "Class", name: "Hero", parentClass: "Actor" } },
      { path: "assets/MyGame.class.babasset", header: { type: "Class", name: "MyGame", parentClass: "GameInstance" } },
      { path: "plugins/pack/assets/Quest.class.babasset", header: { type: "Class", name: "Quest", parentClass: "GameSubsystem" } },
    ];
    expect(
      collectSubsystemClassesForPalette({
        assets,
        openDocuments: [{ ref: { kind: "graph", path: "assets/Save.class.babasset" } }],
        parentOf: classParentLookup(assets),
        classIdForPath: classIdForGraphPath,
      }),
    ).toEqual([
      { classId: "Quest", base: "GameSubsystem" },
      { classId: "Rain_Weather", base: "SceneSubsystem" },
      { classId: "Save", base: "GameSubsystem" },
      { classId: "Weather", base: "SceneSubsystem" },
    ]);
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

describe("collectSceneDocumentsForPalette", () => {
  it("indexes Scene assets by guid and prefers open document actors", () => {
    const scenes = collectSceneDocumentsForPalette({
      assets: [
        {
          path: "assets/Hall.scene.babasset",
          header: {
            guid: "scene-1",
            type: "Scene",
            name: "Hall",
            payload: {
              name: "Main Hall",
              actors: [
                {
                  id: "hero",
                  name: "Hero",
                  classId: "Actor",
                  components: [
                    { id: "mesh-hero", classId: "MeshComponent", properties: {} },
                  ],
                },
              ],
            },
          },
        },
      ],
      openDocuments: [
        {
          ref: { kind: "scene", path: "assets/Hall.scene.babasset" },
          content: {
            name: "Main Hall Live",
            actors: [
              {
                id: "hero",
                name: "Hero",
                classId: "Actor",
                components: [
                  { id: "cam-1", classId: "CameraComponent", properties: {} },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(scenes).toEqual([
      {
        guid: "scene-1",
        name: "Main Hall Live",
        actors: [
          {
            name: "Hero",
            components: [
              { id: "cam-1", classId: "CameraComponent", properties: {} },
            ],
          },
        ],
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

  it("records an Animation Object pin default scrub as one undo step", () => {
    const stack = new DocumentEditStack<Record<string, unknown>>({ maxEntries: 50, maxBytes: 1_000_000 });
    const initial = createDefaultAnimGraph() as unknown as Record<string, unknown>;
    let current = initial;
    const scrub = (value: number) => {
      const graph = serializedGraphFromDocument("anim-graph", current)!;
      const [first, ...rest] = graph.nodes;
      const commit = commitLogicGraph("anim-graph", current, {
        ...graph,
        nodes: [{ ...first!, data: { ...first!.data, "default:rate": value } }, ...rest],
      });
      if (commit.kind !== "anim-graph") throw new Error("expected an Animation Object commit");
      current = stack.apply(current, new SetAssetDocumentCommand(current, commit.payload, commit.mergeKey)).doc;
    };
    scrub(0.5);
    scrub(0.75);
    scrub(1);
    expect(stack.undoDepth).toBe(1);
    expect(stack.undo(current)!.doc).toEqual(initial);
  });
});

describe("collectGraphTypeAssets", () => {
  it.each([null, undefined])("keeps saved Data Definition fields available when a restored tab has %s content", (content) => {
    const fields = [{ id: "damage", name: "Damage", typeId: "int", defaultValue: 12 }];
    const catalog = collectGraphTypeAssets({
      assets: [{ path: "assets/ItemStats.babasset", header: {
        type: "DataDefinition", guid: "stats", name: "ItemStats", payload: { kind: "dataDefinition", fields },
      } }],
      openDocuments: [{ ref: { kind: "data-definition", path: "assets/ItemStats.babasset" }, content }],
    });
    expect(catalog.dataDefinitions).toEqual([{ guid: "stats", name: "ItemStats", fields }]);
    expect(typeSchemasFromGraphAssets(catalog).dataDefinitions?.stats?.fields).toEqual(fields);
  });

  it("keeps Data Definitions independent and projects unsaved fields into graph value schemas", () => {
    const catalog = collectGraphTypeAssets({
      assets: [
        { path: "assets/Stats.babasset", header: { type: "DataDefinition", guid: "stats", name: "Stats", payload: {
          fields: [{ id: "health", name: "Health", typeId: "float", defaultValue: 10 }],
        } } },
        { path: "assets/Vector.babasset", header: { type: "Structure", guid: "vector", name: "Vector", payload: { fields: [] } } },
      ],
      openDocuments: [{ ref: { kind: "data-definition", path: "assets/Stats.babasset" }, content: {
        fields: [{ id: "health", name: "HitPoints", typeId: "float", defaultValue: 25 }],
      } }],
    });
    expect(catalog.dataDefinitions).toEqual([{ guid: "stats", name: "Stats", fields: [
      { id: "health", name: "HitPoints", typeId: "float", defaultValue: 25 },
    ] }]);
    expect(catalog.structures.some((entry) => entry.guid === "stats")).toBe(false);
    const schemas = typeSchemasFromGraphAssets(catalog);
    expect(schemas.dataDefinitions?.stats).toEqual({ name: "Stats", fields: catalog.dataDefinitions[0]!.fields });
    expect(schemas.structs.stats).toEqual(schemas.dataDefinitions?.stats);
    expect(schemas.dataDefinitions?.vector).toBeUndefined();
  });

  it("omits malformed definitions without breaking unrelated type catalogs", () => {
    const catalog = collectGraphTypeAssets({
      assets: [
        { path: "assets/Broken.babasset", header: { type: "DataDefinition", guid: "broken", name: "Broken", payload: { fields: [{ name: "Bad" }] } } },
        { path: "assets/Good.babasset", header: { type: "DataDefinition", guid: "good", name: "Good", payload: { fields: [] } } },
      ],
      openDocuments: [],
    });
    expect(catalog.dataDefinitions.map((entry) => entry.guid)).toEqual(["good"]);
    expect(catalog.structures.some((entry) => entry.guid === "engine:HitResult")).toBe(true);
  });

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
    expect(catalog.structures).toEqual(expect.arrayContaining([
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
      expect.objectContaining({ guid: "engine:InputType", name: "Input Type" }),
      expect.objectContaining({ guid: "engine:InputBinding", name: "Input Binding" }),
      expect.objectContaining({
        guid: "engine:ScalabilitySnapshot", name: "Scalability Snapshot",
        fields: expect.arrayContaining([
          { name: "requested", typeId: "struct", typeClassId: "engine:RuntimeRenderingSettings" },
          { name: "effective", typeId: "struct", typeClassId: "engine:RuntimeRenderingSettings" },
        ]),
      }),
      {
        guid: "struct-stats",
        name: "Stats",
        fields: [{ name: "Health", typeId: "int" }],
      },
    ]));
    expect(catalog.enums).toEqual(expect.arrayContaining([
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
      expect.objectContaining({ guid: "engine:Key", name: "Key" }),
      expect.objectContaining({ guid: "engine:InputComponent", name: "Input Component" }),
      { guid: "engine:RenderMode", name: "Render Mode", members: [{ name: "pbr", value: 0 }, { name: "cel", value: 1 }] },
      {
        guid: "enum-team",
        name: "Team",
        members: [
          { name: "Red", value: 1 },
          { name: "Blue", value: 2 },
        ],
      },
    ]));
    expect(catalog.structures.filter((entry) => entry.guid === "struct-stats")).toHaveLength(1);
    expect(catalog.enums.filter((entry) => entry.guid === "enum-team")).toHaveLength(1);
  });
});

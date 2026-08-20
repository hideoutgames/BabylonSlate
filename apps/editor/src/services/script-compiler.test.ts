import { describe, expect, it } from "vitest";
import {
  userInterfaceClassId,
  type SerializedGraph,
} from "@babylonslate/core";
import {
  classIdForGraphPath,
  compileGraphDocument,
  compileGraphDocuments,
  compileGraphDocumentsForExport,
  GraphScriptCompileCache,
  graphCompileSignature,
  graphsNeedCompile,
  spawnListForScripts,
} from "./script-compiler";

const tickToLog: SerializedGraph = {
  nodes: [
    {
      id: "tick",
      type: "flow.event.tick",
      position: { x: 0, y: 0 },
      data: {},
    },
    {
      id: "log",
      type: "debug.log",
      position: { x: 200, y: 0 },
      data: { message: "hello" },
    },
  ],
  edges: [
    {
      id: "e1",
      source: "tick",
      target: "log",
      sourceHandle: "execOut",
      targetHandle: "execIn",
    },
  ],
};

describe("script compiler service", () => {
  it("derives a stable class id from the graph path", () => {
    expect(classIdForGraphPath("assets/main.graph.babasset")).toBe("main");
    expect(classIdForGraphPath("assets/main.class.babasset")).toBe("main");
    expect(classIdForGraphPath("assets/hero.class.babasset")).toBe("hero");
    expect(classIdForGraphPath("graphs/My Enemy.graph.json")).toBe("My_Enemy");
    expect(classIdForGraphPath("")).toBe("Graph");
    expect(classIdForGraphPath("assets/HUD.ui.babasset")).toBe("HUD");
    expect(classIdForGraphPath("assets/SceneTools.eui.babasset")).toBe(
      "SceneTools",
    );
  });

  it("compiles authored GetAxis2D pin data into getAxis2D(\"Move\")", () => {
    const script = compileGraphDocument(
      {
        nodes: [
          {
            id: "tick",
            type: "flow.event.tick",
            position: { x: 0, y: 0 },
            data: {},
          },
          {
            id: "axis",
            type: "input.getAxis2D",
            position: { x: 0, y: 80 },
            data: { axis: "Move" },
          },
          {
            id: "print",
            type: "debug.print",
            position: { x: 200, y: 0 },
            data: { key: "axis" },
          },
        ],
        edges: [
          {
            id: "e1",
            source: "tick",
            target: "print",
            sourceHandle: "execOut",
            targetHandle: "execIn",
          },
          {
            id: "e2",
            source: "axis",
            target: "print",
            sourceHandle: "out",
            targetHandle: "value",
          },
        ],
      },
      { path: "assets/main.class.babasset" },
    );
    expect(script?.source).toContain('ctx.getAxis2D?.("Move")');
  });

  it("compiles a serialized graph into a runtime script bundle", () => {
    const script = compileGraphDocument(tickToLog, {
      path: "assets/main.graph.babasset",
    });
    expect(script).not.toBeNull();
    expect(script!.classId).toBe("main");
    expect(script!.source).toContain("export function onTick(ctx)");
    expect(script!.source).toContain("ctx.log");
    expect(script!.entryPoints).toEqual([
      { name: "onTick", event: "onTick", nodeId: "tick", isAsync: false },
    ]);
    expect(script!.anchors.some((a) => a.nodeId === "log")).toBe(true);
  });

  it("copies Class member interfaces, variables, and parentClass onto the bundle", () => {
    const script = compileGraphDocument(
      {
        ...tickToLog,
        members: [
          {
            id: "var-health",
            kind: "variable",
            name: "health",
            typeId: "float",
            defaultValue: 80,
          },
          {
            id: "iface-1",
            kind: "interface",
            name: "Damageable",
            assetGuid: "iface-damageable",
          },
        ],
      },
      { path: "assets/Hero.class.babasset", parentClassId: "Actor" },
    );
    expect(script?.parentClassId).toBe("Actor");
    expect(script?.implementedInterfaces).toEqual(["iface-damageable"]);
    expect(script?.variables).toEqual([
      { name: "health", type: "float", defaultValue: 80 },
    ]);
  });

  it("copies Class variable Array/Map containers onto the bundle", () => {
    const script = compileGraphDocument(
      {
        ...tickToLog,
        members: [
          {
            id: "var-hits",
            kind: "variable",
            name: "hits",
            typeId: "rotator",
            container: "array",
            defaultValue: [],
          },
          {
            id: "var-by-name",
            kind: "variable",
            name: "byName",
            typeId: "float",
            container: "map",
            keyTypeId: "string",
          },
        ],
      },
      { path: "assets/Hero.class.babasset", parentClassId: "Actor" },
    );
    expect(script?.variables).toEqual([
      { name: "hits", type: "rotator", container: "array", defaultValue: [] },
      { name: "byName", type: "float", container: "map", keyTypeId: "string" },
    ]);
  });

  it("excludes function-local variables from the bundle and emits lets in the function export", () => {
    const script = compileGraphDocument(
      {
        nodes: [
          {
            id: "begin",
            type: "flow.event.beginPlay",
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
        members: [
          { id: "fn-1", kind: "function", name: "Jump" },
          {
            id: "var-1",
            kind: "variable",
            name: "Health",
            typeId: "float",
            defaultValue: 80,
          },
          {
            id: "loc-1",
            kind: "variable",
            name: "Temp",
            typeId: "float",
            defaultValue: 3,
            functionId: "fn-1",
          },
        ],
        functionGraphs: {
          "fn-1": {
            nodes: [
              {
                id: "in",
                type: "flow.function.input",
                position: { x: 0, y: 0 },
                data: {
                  __protected: true,
                  pins: [
                    { name: "exec", typeId: "exec", direction: "in" },
                    { name: "then", typeId: "exec", direction: "out" },
                  ],
                },
              },
              {
                id: "out",
                type: "flow.function.output",
                position: { x: 200, y: 0 },
                data: {
                  __protected: true,
                  pins: [
                    { name: "exec", typeId: "exec", direction: "in" },
                    { name: "then", typeId: "exec", direction: "out" },
                  ],
                },
              },
            ],
            edges: [
              {
                id: "e1",
                source: "in",
                target: "out",
                sourceHandle: "exec",
                targetHandle: "then",
              },
            ],
          },
        },
      },
      { path: "assets/Hero.class.babasset" },
    );
    expect(script?.variables).toEqual([
      { name: "Health", type: "float", defaultValue: 80 },
    ]);
    expect(script?.source).toContain("export function Jump(ctx) {");
    expect(script?.source).toContain("let __lv_Temp = 3;");
    const jumpIndex = script?.source.indexOf("export function Jump") ?? -1;
    const beginIndex = script?.source.indexOf("export function onBeginPlay") ?? -1;
    expect(jumpIndex).toBeGreaterThan(-1);
    expect(beginIndex).toBeGreaterThan(-1);
    expect(
      script?.source.slice(jumpIndex).includes("let __lv_Temp = 3;"),
    ).toBe(true);
    expect(
      script?.source.slice(beginIndex, jumpIndex).includes("let __lv_Temp"),
    ).toBe(false);
  });

  it("returns null for an empty graph", () => {
    expect(
      compileGraphDocument({ nodes: [], edges: [] }, { path: "a.graph.babasset" }),
    ).toBeNull();
  });

  it("keeps compiling after one graph fails codegen", () => {
    const broken = {
      nodes: [{ id: "x", type: "flow.entry", position: { x: 0, y: 0 } }],
      edges: [],
    } as unknown as SerializedGraph;
    const scripts = compileGraphDocuments([
      { path: "broken.graph.babasset", content: broken },
      { path: "main.graph.babasset", content: tickToLog },
    ]);
    expect(scripts.map((s) => s.classId)).toContain("main");
  });

  it("strips Print from export compiles and keeps it for Play", () => {
    const tickToPrint: SerializedGraph = {
      nodes: [
        {
          id: "tick",
          type: "flow.event.tick",
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "print",
          type: "debug.print",
          position: { x: 200, y: 0 },
          data: { value: "debug" },
        },
        {
          id: "log",
          type: "debug.log",
          position: { x: 400, y: 0 },
          data: { message: "kept" },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "tick",
          target: "print",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
        {
          id: "e2",
          source: "print",
          target: "log",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };
    const play = compileGraphDocument(tickToPrint, {
      path: "assets/main.class.babasset",
    });
    expect(play?.source).toContain("ctx.print");
    expect(play?.source).toContain("ctx.log");
    expect(play?.source).toContain("ctx.checkInfiniteLoop();");
    const preview = compileGraphDocuments([
      { path: "assets/main.class.babasset", content: tickToPrint },
    ]);
    expect(preview[0]?.source).toContain("ctx.print");
    expect(preview[0]?.source).toContain("ctx.checkInfiniteLoop();");
    const exported = compileGraphDocumentsForExport([
      { path: "assets/main.class.babasset", content: tickToPrint },
    ]);
    expect(exported[0]?.source).not.toContain("ctx.print");
    expect(exported[0]?.source).toContain("ctx.log");
    expect(exported[0]?.source).not.toContain("checkInfiniteLoop");
  });

  it("only spawns actors for scripts bound to a lifecycle event", () => {
    const withEvent = compileGraphDocument(tickToLog, {
      path: "assets/main.graph.babasset",
    })!;
    const withoutEvent = {
      ...withEvent,
      classId: "loose",
      entryPoints: [{ name: "run", isAsync: false }],
    };
    expect(spawnListForScripts([withEvent, withoutEvent])).toEqual([
      { classId: "main" },
    ]);
  });

  it("compiles OnCommandRun into a core console command and does not spawn an actor", () => {
    const graph: SerializedGraph = {
      nodes: [
        {
          id: "run",
          type: "flow.event.commandRun",
          position: { x: 0, y: 0 },
          data: {
            commandName: "heal",
            description: "Heal the player",
            category: "game",
            parameters: [{ name: "amount", type: "float" }],
          },
        },
        {
          id: "report",
          type: "debug.reportCommand",
          position: { x: 200, y: 0 },
          data: { success: true, output: "ok" },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "run",
          target: "report",
          sourceHandle: "execOut",
          targetHandle: "execIn",
        },
      ],
    };
    const script = compileGraphDocument(graph, {
      path: "assets/HealCommand.graph.babasset",
    });
    expect(script?.command).toEqual({
      name: "heal",
      description: "Heal the player",
      category: "game",
      parameters: [{ name: "amount", type: "float" }],
    });
    expect(script?.entryPoints.some((entry) => entry.event === "onCommandRun")).toBe(
      true,
    );
    expect(spawnListForScripts([script!])).toEqual([]);
  });

  it("compiles UI onWidgetClick default:message into the log literal", () => {
    const script = compileGraphDocument(
      {
        nodes: [
          {
            id: "click",
            type: "flow.event.custom",
            position: { x: 40, y: 80 },
            data: { name: "onWidgetClick" },
          },
          {
            id: "log",
            type: "debug.log",
            position: { x: 320, y: 80 },
            data: { "default:message": "hud-clicked" },
          },
        ],
        edges: [
          {
            id: "e1",
            source: "click",
            target: "log",
            sourceHandle: "execOut",
            targetHandle: "execIn",
          },
        ],
      },
      {
        path: "assets/HUD.ui.babasset",
        classId: "UserInterface:hud-guid",
        parentClassId: "UserInterface",
      },
    );
    expect(script?.entryPoints.some((entry) => entry.event === "onWidgetClick")).toBe(
      true,
    );
    expect(script?.source).toContain("hud-clicked");
  });

  it("binds a UserInterface script to an explicit guid class id", () => {
    const classId = userInterfaceClassId("hud-guid");
    const script = compileGraphDocument(tickToLog, {
      path: "assets/HUD.ui.babasset",
      classId,
      parentClassId: "UserInterface",
    });
    expect(script?.classId).toBe(classId);
    expect(script?.parentClassId).toBe("UserInterface");
    expect(script?.classId).not.toBe("HUD");
  });

  it("does not spawn actors for UserInterface script class ids", () => {
    const classId = userInterfaceClassId("hud-guid");
    const script = compileGraphDocument(tickToLog, {
      path: "assets/HUD.ui.babasset",
      classId,
      parentClassId: "UserInterface",
    })!;
    expect(script.entryPoints.some((entry) => entry.event === "onTick")).toBe(
      true,
    );
    expect(spawnListForScripts([script])).toEqual([]);
  });
});

describe("graphCompileSignature", () => {
  it("ignores node positions so layout does not count as a compile change", () => {
    const moved: SerializedGraph = {
      ...tickToLog,
      nodes: tickToLog.nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + 40, y: node.position.y + 10 },
      })),
    };
    expect(
      graphCompileSignature([{ path: "assets/main.graph.babasset", content: tickToLog }]),
    ).toBe(
      graphCompileSignature([{ path: "assets/main.graph.babasset", content: moved }]),
    );
  });

  it("changes when node data or edges change", () => {
    const edited: SerializedGraph = {
      ...tickToLog,
      nodes: tickToLog.nodes.map((node) =>
        node.id === "log"
          ? { ...node, data: { message: "goodbye" } }
          : node,
      ),
    };
    const disconnected: SerializedGraph = { ...tickToLog, edges: [] };
    const base = graphCompileSignature([
      { path: "assets/main.graph.babasset", content: tickToLog },
    ]);
    expect(
      graphCompileSignature([{ path: "assets/main.graph.babasset", content: edited }]),
    ).not.toBe(base);
    expect(
      graphCompileSignature([
        { path: "assets/main.graph.babasset", content: disconnected },
      ]),
    ).not.toBe(base);
  });

  it("is order-independent across documents", () => {
    const other: SerializedGraph = { nodes: [], edges: [] };
    const a = { path: "assets/a.graph.babasset", content: tickToLog };
    const b = { path: "assets/b.graph.babasset", content: other };
    expect(graphCompileSignature([a, b])).toBe(graphCompileSignature([b, a]));
  });

  it("changes when a function graph changes", () => {
    const withFn: SerializedGraph = {
      ...tickToLog,
      functionGraphs: {
        "fn-1": {
          nodes: [
            {
              id: "in",
              type: "flow.function.input",
              position: { x: 0, y: 0 },
              data: { __protected: true },
            },
          ],
          edges: [],
        },
      },
    };
    const base = graphCompileSignature([
      { path: "assets/hero.class.babasset", content: tickToLog },
    ]);
    expect(
      graphCompileSignature([
        { path: "assets/hero.class.babasset", content: withFn },
      ]),
    ).not.toBe(base);
  });
});

describe("graphsNeedCompile", () => {
  it("is true before any compile and false when the signature matches", () => {
    const signature = graphCompileSignature([
      { path: "assets/main.graph.babasset", content: tickToLog },
    ]);
    expect(graphsNeedCompile(signature, null)).toBe(true);
    expect(graphsNeedCompile(signature, signature)).toBe(false);
    expect(graphsNeedCompile(`${signature}-edited`, signature)).toBe(true);
  });
});

describe("GraphScriptCompileCache", () => {
  it("Play-prepares many graphs without recompiling an unchanged graph", () => {
    const cache = new GraphScriptCompileCache();
    const documents = Array.from({ length: 24 }, (_, index) => ({
      path: `assets/g${index}.class.babasset`,
      content: tickToLog,
    }));
    const first = compileGraphDocuments(documents, { cache });
    expect(first).toHaveLength(24);
    expect(cache.compiles).toBe(24);
    const second = compileGraphDocuments(documents, { cache });
    expect(second.map((script) => script.source)).toEqual(
      first.map((script) => script.source),
    );
    expect(cache.compiles).toBe(24);
    const moved: SerializedGraph = {
      ...tickToLog,
      nodes: tickToLog.nodes.map((node) => ({
        ...node,
        position: { x: 99, y: 40 },
      })),
    };
    compileGraphDocuments(
      documents.map((doc, index) =>
        index === 0 ? { ...doc, content: moved } : doc,
      ),
      { cache },
    );
    expect(cache.compiles).toBe(24);
    const edited: SerializedGraph = {
      ...tickToLog,
      nodes: tickToLog.nodes.map((node) =>
        node.id === "log"
          ? { ...node, data: { message: "changed" } }
          : node,
      ),
    };
    compileGraphDocuments(
      documents.map((doc, index) =>
        index === 0 ? { ...doc, content: edited } : doc,
      ),
      { cache },
    );
    expect(cache.compiles).toBe(25);
  });

  it("does not reuse a Play bundle for a Development Only export compile", () => {
    const cache = new GraphScriptCompileCache();
    compileGraphDocuments(
      [{ path: "assets/main.class.babasset", content: tickToLog }],
      { cache },
    );
    compileGraphDocuments(
      [{ path: "assets/main.class.babasset", content: tickToLog }],
      { cache, stripDevelopmentOnly: true },
    );
    expect(cache.compiles).toBe(2);
  });

  it("fingerprints type schemas instead of embedding them in every cache key", () => {
    const cache = new GraphScriptCompileCache();
    const enums = {
      "enum-1": {
        name: "Huge",
        members: Array.from({ length: 80 }, (_, index) => ({
          name: `Member${index}`,
          value: index,
        })),
      },
    };
    compileGraphDocuments(
      [{ path: "assets/main.class.babasset", content: tickToLog }],
      { cache, enums },
    );
    const key = [...cache.graphs.keys()][0] ?? "";
    expect(key).not.toContain("Member79");
    expect(key.length).toBeLessThan(800);
    compileGraphDocuments(
      [{ path: "assets/main.class.babasset", content: tickToLog }],
      { cache, enums: structuredClone(enums) },
    );
    expect(cache.compiles).toBe(1);
    compileGraphDocuments(
      [{ path: "assets/main.class.babasset", content: tickToLog }],
      {
        cache,
        enums: {
          "enum-1": {
            name: "Huge",
            members: [{ name: "Changed", value: 0 }],
          },
        },
      },
    );
    expect(cache.compiles).toBe(2);
  });

  it("retries a graph that threw during codegen instead of caching the failure", () => {
    const cache = new GraphScriptCompileCache();
    const broken = {
      nodes: [{ id: "x", type: "flow.entry", position: { x: 0, y: 0 } }],
      edges: [],
    } as unknown as SerializedGraph;
    compileGraphDocuments(
      [{ path: "broken.graph.babasset", content: broken }],
      { cache },
    );
    expect(cache.compiles).toBe(1);
    expect(cache.graphs.size).toBe(0);
    compileGraphDocuments(
      [{ path: "broken.graph.babasset", content: broken }],
      { cache },
    );
    expect(cache.compiles).toBe(2);
  });

  it("forgets compiled bundles when the project cache is cleared", () => {
    const cache = new GraphScriptCompileCache();
    compileGraphDocuments(
      [{ path: "assets/main.class.babasset", content: tickToLog }],
      { cache },
    );
    cache.clear();
    compileGraphDocuments(
      [{ path: "assets/main.class.babasset", content: tickToLog }],
      { cache },
    );
    expect(cache.compiles).toBe(1);
  });

  it("treats classId and parentClassId as part of the cache key", () => {
    const cache = new GraphScriptCompileCache();
    const doc = { path: "assets/main.class.babasset", content: tickToLog };
    compileGraphDocuments([{ ...doc, classId: "Hero" }], { cache });
    compileGraphDocuments([{ ...doc, classId: "Hero" }], { cache });
    expect(cache.compiles).toBe(1);
    compileGraphDocuments([{ ...doc, classId: "Villain" }], { cache });
    expect(cache.compiles).toBe(2);
    compileGraphDocuments(
      [{ ...doc, classId: "Hero", parentClassId: "Pawn" }],
      { cache },
    );
    expect(cache.compiles).toBe(3);
  });

  it("caches an empty graph null bundle instead of retrying codegen", () => {
    const cache = new GraphScriptCompileCache();
    const empty: SerializedGraph = { nodes: [], edges: [] };
    expect(
      compileGraphDocuments(
        [{ path: "assets/empty.class.babasset", content: empty }],
        { cache },
      ),
    ).toEqual([]);
    expect(cache.compiles).toBe(1);
    expect([...cache.graphs.values()]).toEqual([null]);
    compileGraphDocuments(
      [{ path: "assets/empty.class.babasset", content: empty }],
      { cache },
    );
    expect(cache.compiles).toBe(1);
  });
});

describe("compileAnimGraphScripts", () => {
  it("compiles Animation Object lifecycle and each transition rule", async () => {
    const { createDefaultAnimGraph } = await import("@babylonslate/anim-graph");
    const { compileAnimGraphScripts } = await import("./script-compiler");
    const doc = createDefaultAnimGraph();
    doc.transitions.push({
      id: "idle-to-idle",
      fromStateId: "idle",
      toStateId: "idle",
      blendSeconds: 0,
      priority: 0,
      ruleGraph: {
        nodes: [
          {
            id: "enter-state",
            type: "anim.rule.enterState",
            position: { x: 0, y: 0 },
            data: { __protected: true },
          },
          {
            id: "exit-state",
            type: "anim.rule.exitState",
            position: { x: 0, y: 80 },
            data: { __protected: true },
          },
        ],
        edges: [],
      },
    });
    const scripts = compileAnimGraphScripts([
      { guid: "graph-1", path: "assets/Loco.anim.babasset", document: doc },
    ]);
    expect(scripts.map((entry) => entry.classId)).toEqual([
      "AnimGraph:graph-1",
      "AnimRule:graph-1:idle-to-idle",
    ]);
    expect(scripts[0]?.entryPoints.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(["onInitializeAnimation", "onUpdateAnimation"]),
    );
    expect(scripts[1]?.source).toContain("export function evaluate(ctx)");
    expect(scripts[1]?.source).toContain("enter: (true)");
  });

  it("reuses Animation Graph compiles when the document is unchanged", async () => {
    const { createDefaultAnimGraph } = await import("@babylonslate/anim-graph");
    const { compileAnimGraphScripts, GraphScriptCompileCache } = await import(
      "./script-compiler"
    );
    const cache = new GraphScriptCompileCache();
    const doc = createDefaultAnimGraph();
    const entry = {
      guid: "graph-1",
      path: "assets/Loco.anim.babasset",
      document: doc,
    };
    const first = compileAnimGraphScripts([entry], { cache });
    expect(first.length).toBeGreaterThan(0);
    expect(cache.compiles).toBe(1);
    const second = compileAnimGraphScripts([entry], { cache });
    expect(second).toEqual(first);
    expect(cache.compiles).toBe(1);
  });

  it("does not recompile an Animation Graph after a position-only canvas nudge", async () => {
    const { createDefaultAnimGraph } = await import("@babylonslate/anim-graph");
    const { compileAnimGraphScripts, GraphScriptCompileCache } = await import(
      "./script-compiler"
    );
    const cache = new GraphScriptCompileCache();
    const doc = createDefaultAnimGraph();
    const entry = {
      guid: "graph-1",
      path: "assets/Loco.anim.babasset",
      document: doc,
    };
    compileAnimGraphScripts([entry], { cache });
    expect(cache.compiles).toBe(1);
    const nudged = createDefaultAnimGraph();
    nudged.animationObject = {
      ...nudged.animationObject,
      nodes: nudged.animationObject.nodes.map((node) => ({
        ...node,
        position: { x: 99, y: 40 },
      })),
    };
    nudged.states = nudged.states.map((state) => ({
      ...state,
      position: { x: 50, y: 80 },
    }));
    compileAnimGraphScripts(
      [{ guid: "graph-1", path: "assets/Loco.anim.babasset", document: nudged }],
      { cache },
    );
    expect(cache.compiles).toBe(1);
  });

  it("recompiles an Animation Graph when animation object data changes", async () => {
    const { createDefaultAnimGraph } = await import("@babylonslate/anim-graph");
    const { compileAnimGraphScripts, GraphScriptCompileCache } = await import(
      "./script-compiler"
    );
    const cache = new GraphScriptCompileCache();
    const doc = createDefaultAnimGraph();
    compileAnimGraphScripts(
      [{ guid: "graph-1", path: "assets/Loco.anim.babasset", document: doc }],
      { cache },
    );
    expect(cache.compiles).toBe(1);
    const edited = createDefaultAnimGraph();
    edited.animationObject = {
      ...edited.animationObject,
      nodes: edited.animationObject.nodes.map((node) =>
        node.id === "event-update"
          ? { ...node, data: { ...node.data, title: "changed" } }
          : node,
      ),
    };
    compileAnimGraphScripts(
      [{ guid: "graph-1", path: "assets/Loco.anim.babasset", document: edited }],
      { cache },
    );
    expect(cache.compiles).toBe(2);
  });

  it("does not reuse a Play Animation Graph compile for a Development Only export", async () => {
    const { createDefaultAnimGraph } = await import("@babylonslate/anim-graph");
    const { compileAnimGraphScripts, GraphScriptCompileCache } = await import(
      "./script-compiler"
    );
    const cache = new GraphScriptCompileCache();
    const entry = {
      guid: "graph-1",
      path: "assets/Loco.anim.babasset",
      document: createDefaultAnimGraph(),
    };
    compileAnimGraphScripts([entry], { cache });
    compileAnimGraphScripts([entry], { cache, stripDevelopmentOnly: true });
    expect(cache.compiles).toBe(2);
  });

  it("compiles a one-way Exit State as true even when a variable is wired to it", async () => {
    const { createDefaultAnimGraph } = await import("@babylonslate/anim-graph");
    const { compileAnimGraphScripts } = await import("./script-compiler");
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      blendSeconds: 0,
      priority: 0,
      ruleGraph: {
        nodes: [
          {
            id: "enter-state",
            type: "anim.rule.enterState",
            position: { x: 0, y: 0 },
            data: { __protected: true },
          },
          {
            id: "exit-state",
            type: "anim.rule.exitState",
            position: { x: 0, y: 80 },
            data: { __protected: true },
          },
          {
            id: "get-moving",
            type: "variables.get",
            position: { x: 0, y: 160 },
            data: {
              variableName: "moving",
              typeId: "bool",
              implicitSelf: true,
            },
          },
        ],
        edges: [
          {
            id: "e-exit",
            source: "get-moving",
            target: "exit-state",
            sourceHandle: "value",
            targetHandle: "value",
          },
        ],
      },
    });
    const scripts = compileAnimGraphScripts([
      { guid: "graph-1", path: "assets/Loco.anim.babasset", document: doc },
    ]);
    const rule = scripts.find((entry) => entry.classId === "AnimRule:graph-1:idle-to-run");
    expect(rule?.source).toContain("exit: (true)");
    expect(rule?.source).not.toContain("exit-state");
  });
});

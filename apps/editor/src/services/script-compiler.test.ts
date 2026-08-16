import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  classIdForGraphPath,
  compileGraphDocument,
  compileGraphDocuments,
  compileGraphDocumentsForExport,
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

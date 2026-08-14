import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  classIdForGraphPath,
  compileGraphDocument,
  compileGraphDocuments,
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

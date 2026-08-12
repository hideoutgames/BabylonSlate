import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@babylonslate/core";
import {
  classIdForGraphPath,
  compileGraphDocument,
  compileGraphDocuments,
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
    expect(classIdForGraphPath("graphs/My Enemy.graph.json")).toBe("My_Enemy");
    expect(classIdForGraphPath("")).toBe("Graph");
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
});

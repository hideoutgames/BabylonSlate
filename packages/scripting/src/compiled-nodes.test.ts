import { describe, expect, it } from "vitest";
import { compiledNodeIds } from "./compiled-nodes";
import type { GraphEdge, GraphNode, LogicGraph } from "./ir";
import { pin } from "./node-registry";
import { BOOL, EXEC, FLOAT, INT, STRING } from "./types";

function node(
  id: string,
  typeId: string,
  pins: GraphNode["pins"],
): GraphNode {
  return { id, typeId, position: { x: 0, y: 0 }, pins, properties: {} };
}

function execEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  sourcePinId = "execOut",
  targetPinId = "execIn",
): GraphEdge {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function dataEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  sourcePinId: string,
  targetPinId: string,
): GraphEdge {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function graph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  kind: LogicGraph["kind"] = "event",
): LogicGraph {
  return { id: "g", kind, nodes, edges };
}

const execInOut = [
  pin("execIn", "exec", "in", EXEC),
  pin("execOut", "then", "out", EXEC),
];

describe("compiledNodeIds", () => {
  it("includes an isolated custom event and excludes a leftover Destroy Actor", () => {
    const ids = compiledNodeIds(
      graph(
        [
          node("onHit", "flow.event.custom", [
            pin("execOut", "then", "out", EXEC),
          ]),
          node("destroy", "actor.destroy", [
            ...execInOut,
            pin("target", "target", "in", STRING),
          ]),
        ],
        [],
      ),
    );
    expect([...ids].sort()).toEqual(["onHit"]);
  });

  it("includes Destroy Actor when Begin Play executes it", () => {
    const ids = compiledNodeIds(
      graph(
        [
          node("begin", "flow.event.beginPlay", [
            pin("execOut", "then", "out", EXEC),
          ]),
          node("destroy", "actor.destroy", execInOut),
        ],
        [execEdge("e1", "begin", "destroy")],
      ),
    );
    expect(ids.has("begin")).toBe(true);
    expect(ids.has("destroy")).toBe(true);
  });

  it("excludes a wired exec island that never roots at a trigger", () => {
    const ids = compiledNodeIds(
      graph(
        [
          node("print", "debug.print", execInOut),
          node("delay", "flow.delay", execInOut),
        ],
        [execEdge("e1", "print", "delay")],
      ),
    );
    expect(ids.size).toBe(0);
  });

  it("includes both Branch arms wired from Begin Play", () => {
    const ids = compiledNodeIds(
      graph(
        [
          node("begin", "flow.event.beginPlay", [
            pin("execOut", "then", "out", EXEC),
          ]),
          node("branch", "flow.branch", [
            pin("execIn", "exec", "in", EXEC),
            pin("true", "true", "out", EXEC),
            pin("false", "false", "out", EXEC),
            pin("condition", "condition", "in", BOOL),
          ]),
          node("thenLog", "debug.log", execInOut),
          node("elseLog", "debug.log", execInOut),
        ],
        [
          execEdge("e1", "begin", "branch"),
          execEdge("e2", "branch", "thenLog", "true", "execIn"),
          execEdge("e3", "branch", "elseLog", "false", "execIn"),
        ],
      ),
    );
    expect(ids.has("branch")).toBe(true);
    expect(ids.has("thenLog")).toBe(true);
    expect(ids.has("elseLog")).toBe(true);
  });

  it("includes a pure Add that a compiled Log reads and skips an unused Add", () => {
    const ids = compiledNodeIds(
      graph(
        [
          node("begin", "flow.event.beginPlay", [
            pin("execOut", "then", "out", EXEC),
          ]),
          node("log", "debug.log", [
            ...execInOut,
            pin("message", "message", "in", STRING),
          ]),
          node("used", "math.add", [
            pin("a", "a", "in", INT),
            pin("b", "b", "in", INT),
            pin("out", "out", "out", INT),
          ]),
          node("unused", "math.add", [
            pin("a", "a", "in", INT),
            pin("b", "b", "in", INT),
            pin("out", "out", "out", INT),
          ]),
        ],
        [
          execEdge("e1", "begin", "log"),
          dataEdge("d1", "used", "log", "out", "message"),
        ],
      ),
    );
    expect(ids.has("used")).toBe(true);
    expect(ids.has("unused")).toBe(false);
  });

  it("does not compile an untriggered impure node just because a compiled node reads its data", () => {
    const ids = compiledNodeIds(
      graph(
        [
          node("begin", "flow.event.beginPlay", [
            pin("execOut", "then", "out", EXEC),
          ]),
          node("log", "debug.log", [
            ...execInOut,
            pin("message", "message", "in", STRING),
          ]),
          node("trace", "trace.line", [
            ...execInOut,
            pin("hit", "hit", "out", STRING),
          ]),
        ],
        [
          execEdge("e1", "begin", "log"),
          dataEdge("d1", "trace", "log", "hit", "message"),
        ],
      ),
    );
    expect(ids.has("log")).toBe(true);
    expect(ids.has("trace")).toBe(false);
  });

  it("includes function Input and Output only when Output is exec-reachable", () => {
    const isolated = compiledNodeIds(
      graph(
        [
          node("in", "flow.function.input", [
            pin("execOut", "then", "out", EXEC),
          ]),
          node("out", "flow.function.output", [
            pin("execIn", "exec", "in", EXEC),
            pin("remaining", "remaining", "in", FLOAT),
          ]),
        ],
        [],
        "function",
      ),
    );
    expect([...isolated].sort()).toEqual(["in"]);

    const wired = compiledNodeIds(
      graph(
        [
          node("in", "flow.function.input", [
            pin("execOut", "then", "out", EXEC),
          ]),
          node("out", "flow.function.output", [
            pin("execIn", "exec", "in", EXEC),
            pin("remaining", "remaining", "in", FLOAT),
          ]),
        ],
        [execEdge("e1", "in", "out")],
        "function",
      ),
    );
    expect(wired.has("in")).toBe(true);
    expect(wired.has("out")).toBe(true);
  });

  it("includes animation rule sinks and pures they read, not leftover pures", () => {
    const ids = compiledNodeIds(
      graph(
        [
          node("enter", "anim.rule.enterState", [
            pin("value", "value", "in", BOOL),
          ]),
          node("exit", "anim.rule.exitState", [
            pin("value", "value", "in", BOOL),
          ]),
          node("used", "math.equals", [
            pin("a", "a", "in", FLOAT),
            pin("b", "b", "in", FLOAT),
            pin("out", "out", "out", BOOL),
          ]),
          node("unused", "math.add", [
            pin("a", "a", "in", INT),
            pin("out", "out", "out", INT),
          ]),
        ],
        [dataEdge("d1", "used", "enter", "out", "value")],
      ),
    );
    expect(ids.has("enter")).toBe(true);
    expect(ids.has("exit")).toBe(true);
    expect(ids.has("used")).toBe(true);
    expect(ids.has("unused")).toBe(false);
  });

  it("pulls a chain of data-only nodes that feed a compiled consumer", () => {
    const ids = compiledNodeIds(
      graph(
        [
          node("begin", "flow.entry", [pin("execOut", "then", "out", EXEC)]),
          node("log", "debug.log", [
            ...execInOut,
            pin("message", "message", "in", STRING),
          ]),
          node("inner", "math.add", [
            pin("a", "a", "in", INT),
            pin("out", "out", "out", INT),
          ]),
          node("outer", "math.add", [
            pin("a", "a", "in", INT),
            pin("out", "out", "out", INT),
          ]),
        ],
        [
          execEdge("e1", "begin", "log"),
          dataEdge("d1", "inner", "outer", "out", "a"),
          dataEdge("d2", "outer", "log", "out", "message"),
        ],
      ),
    );
    expect(ids.has("inner")).toBe(true);
    expect(ids.has("outer")).toBe(true);
  });
});

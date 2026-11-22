import { describe, expect, it } from "vitest";
import { findExecuteJavaScriptNodes, hasExecuteJavaScriptBody } from "./execute-javascript";

const node = (id: string, data: Record<string, unknown>, type = "debug.executeJavaScript") =>
  ({ id, type, position: { x: 0, y: 0 }, data });

describe("findExecuteJavaScriptNodes", () => {
  it("finds saved and compiled nodes wherever a document nests them, naming the Class function a node is in", () => {
    const classDocument = {
      nodes: [node("event", { body: "ctx.log('event');" }), node("tick", {}, "flow.event.tick")],
      edges: [],
      members: [{ id: "fn-1", kind: "function", name: "Fire" }],
      functionGraphs: { "fn-1": { nodes: [node("inFunction", { body: "fetch('x')" })], edges: [] } },
    };
    const scene = { actors: [], script: { nodes: [node("sceneNode", { body: "1" })], edges: [] } };
    const animGraph = {
      stateMachine: { states: [{ id: "idle", stateGraph: { nodes: [], edges: [] } }], transitions: [] },
      animationObject: { nodes: [{ id: "compiled", typeId: "debug.executeJavaScript", properties: { body: "2" } }], edges: [] },
    };
    expect(findExecuteJavaScriptNodes(classDocument)).toEqual([
      { nodeId: "event", body: "ctx.log('event');" },
      { nodeId: "inFunction", functionName: "Fire", body: "fetch('x')" },
    ]);
    expect(findExecuteJavaScriptNodes(scene)).toEqual([{ nodeId: "sceneNode", body: "1" }]);
    expect(findExecuteJavaScriptNodes(animGraph)).toEqual([{ nodeId: "compiled", body: "2" }]);
  });

  it("judges a node by the type it hydrates as, so a saved __nodeType cannot hide one", () => {
    expect(findExecuteJavaScriptNodes({ nodes: [node("hidden", { __nodeType: "debug.executeJavaScript", body: "x()" }, "flow.branch")] }))
      .toEqual([{ nodeId: "hidden", body: "x()" }]);
  });

  it("counts any body that is not only whitespace, comments and non-string values included, as codegen compiles them", () => {
    const found = findExecuteJavaScriptNodes({
      nodes: [
        node("empty", { body: "" }),
        node("blank", { body: "  \n\t" }),
        node("missing", {}),
        node("comment", { body: "// only a comment" }),
        node("array", { body: ["alert(1)"] }),
      ],
    });
    expect(found.map((entry) => entry.nodeId)).toEqual(["comment", "array"]);
    expect(found[1]!.body).toBe("alert(1)");
    expect(hasExecuteJavaScriptBody(null)).toBe(false);
    expect(hasExecuteJavaScriptBody(0)).toBe(true);
  });

  it("walks a document nested far deeper than the call stack allows", () => {
    let deep: unknown = { nodes: [node("deep", { body: "y()" })] };
    for (let depth = 0; depth < 100_000; depth += 1) deep = { child: deep };
    expect(findExecuteJavaScriptNodes(deep)).toEqual([{ nodeId: "deep", body: "y()" }]);
  });
});

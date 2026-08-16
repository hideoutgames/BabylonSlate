import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile";
import type { LogicGraph } from "./ir";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC } from "./types";

describe("compileGraph localPreamble", () => {
  it("inserts function-scoped lets after the export opening brace", () => {
    const nodes = new NodeRegistry();
    nodes.register({
      id: "noop",
      title: "Noop",
      category: "flow",
      pins: () => [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
      ],
      codegen: () => {},
    });
    const graph: LogicGraph = {
      id: "Jump",
      kind: "function",
      nodes: [
        {
          id: "n",
          typeId: "noop",
          position: { x: 0, y: 0 },
          pins: [
            pin("execIn", "exec", "in", EXEC),
            pin("execOut", "then", "out", EXEC),
          ],
          properties: {},
        },
      ],
      edges: [],
    };
    const compiled = compileGraph(graph, {
      assetGuid: "a",
      registry: nodes,
      exportName: "Jump",
      localPreamble: ["  let __lv_Temp = 3;"],
    });
    expect(compiled.source).toContain(
      "export function Jump(ctx) {\n  let __lv_Temp = 3;",
    );
  });
});

import { describe, expect, it } from "vitest";
import { createEmptyLogicGraph } from "@babylonslate/scripting";
import type { CodegenContext } from "@babylonslate/scripting";
import { allNodeDefinitions } from "./index";

function mockCtx(): CodegenContext {
  const emits: string[] = [];
  const hoists: string[] = [];
  return {
    graph: createEmptyLogicGraph("g"),
    node: {
      id: "n1",
      typeId: "test",
      position: { x: 0, y: 0 },
      pins: [],
      properties: {
        body: "return;",
        inputs: [{ name: "a", type: { kind: "float" } }],
        outputs: [{ name: "b", type: { kind: "float" } }],
        count: 2,
        structGuid: "struct-stats",
        fields: [{ name: "Health", typeId: "int" }],
        enumGuid: "enum-team",
        members: [{ name: "Red", value: 1 }],
        value: "Red",
      },
    },
    indent: "  ",
    input: () => "0",
    output: (name) => `_out_${name}`,
    emit: (s) => {
      emits.push(s);
    },
    hoist: (s) => {
      hoists.push(s);
    },
    requestAsync: () => {},
  };
}

describe("catalog codegen smoke", () => {
  it("builds pins and runs codegen for every registered node", () => {
    const defs = allNodeDefinitions();
    expect(defs.length).toBeGreaterThan(40);
    for (const def of defs) {
      const pins = def.pins({
        body: "b = a;",
        inputs: [{ name: "a", type: { kind: "float" } }],
        outputs: [{ name: "b", type: { kind: "float" } }],
        count: 3,
        structGuid: "struct-stats",
        fields: [{ name: "Health", typeId: "int" }],
        enumGuid: "enum-team",
        members: [{ name: "Red", value: 1 }],
        value: "Red",
      });
      expect(pins.length).toBeGreaterThan(0);
      const result = def.codegen(mockCtx());
      if (result && typeof result === "object") {
        expect(Object.keys(result).length).toBeGreaterThan(0);
      }
    }
  });
});

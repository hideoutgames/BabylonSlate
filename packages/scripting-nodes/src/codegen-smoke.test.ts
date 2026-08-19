import { describe, expect, it } from "vitest";
import { createEmptyLogicGraph } from "@babylonslate/scripting";
import type { CodegenContext } from "@babylonslate/scripting";
import { allNodeDefinitions } from "./index";

const PROPERTIES = {
  body: "b = a;",
  inputs: [{ name: "a", type: { kind: "float" } }],
  outputs: [{ name: "b", type: { kind: "float" } }],
  count: 3,
  structGuid: "struct-stats",
  fields: [{ name: "Health", typeId: "int" }],
  enumGuid: "enum-team",
  members: [{ name: "Red", value: 1 }],
  value: "Red",
};

function mockCtx(
  typeId = "test",
  pins: CodegenContext["node"]["pins"] = [],
): {
  ctx: CodegenContext;
  inputs: string[];
  outputs: string[];
} {
  const emits: string[] = [];
  const hoists: string[] = [];
  const inputs: string[] = [];
  const outputs: string[] = [];
  return {
    inputs,
    outputs,
    ctx: {
    graph: createEmptyLogicGraph("g"),
    node: {
      id: "n1",
      typeId,
      position: { x: 0, y: 0 },
      pins,
      properties: PROPERTIES,
    },
    indent: "  ",
    input: (name) => {
      inputs.push(name);
      return "0";
    },
    output: (name) => {
      outputs.push(name);
      return `_out_${name}`;
    },
    emit: (s) => {
      emits.push(s);
    },
    hoist: (s) => {
      hoists.push(s);
    },
    requestAsync: () => {},
    },
  };
}

describe("catalog codegen smoke", () => {
  it("builds pins and runs codegen for every registered node", () => {
    const defs = allNodeDefinitions();
    expect(defs.length).toBeGreaterThan(40);
    expect(new Set(defs.map((def) => def.id)).size).toBe(defs.length);
    for (const def of defs) {
      expect(def.title.trim(), `${def.id} title`).not.toBe("");
      expect(def.category.trim(), `${def.id} category`).not.toBe("");
      const pins = def.pins(PROPERTIES);
      expect(pins.length).toBeGreaterThan(0);
      expect(new Set(pins.map((pin) => pin.id)).size, `${def.id} pin ids`).toBe(
        pins.length,
      );
      expect(
        pins.every((pin) => pin.name.trim().length > 0),
        `${def.id} pin names`,
      ).toBe(true);
      const access = mockCtx(def.id, pins);
      const result = def.codegen(access.ctx);
      if (result && typeof result === "object") {
        expect(Object.keys(result).length).toBeGreaterThan(0);
        for (const output of Object.keys(result)) {
          expect(
            pins.some(
              (pin) =>
                pin.direction === "out" &&
                (pin.id === output || pin.name === output),
            ),
            `${def.id} returned undeclared output ${output}`,
          ).toBe(true);
        }
      }
      for (const input of access.inputs) {
        expect(
          pins.some(
            (pin) =>
              pin.direction === "in" &&
              (pin.id === input || pin.name === input),
          ),
          `${def.id} read undeclared input ${input}`,
        ).toBe(true);
      }
      for (const output of access.outputs) {
        expect(
          pins.some(
            (pin) =>
              pin.direction === "out" &&
              (pin.id === output || pin.name === output),
          ),
          `${def.id} wrote undeclared output ${output}`,
        ).toBe(true);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { createEmptyLogicGraph } from "@babylonslate/scripting";
import type { CodegenContext } from "@babylonslate/scripting";
import { behaviourTreeNodes } from "./behaviour-tree";

function mockCtx(overrides?: Partial<CodegenContext>): CodegenContext {
  const emits: string[] = [];
  return {
    graph: createEmptyLogicGraph("g"),
    node: {
      id: "n1",
      typeId: "test",
      position: { x: 0, y: 0 },
      pins: [],
      properties: {},
    },
    indent: "  ",
    input: () => "0",
    output: (name) => `_out_${name}`,
    emit: (s) => {
      emits.push(s);
    },
    hoist: () => {},
    requestAsync: () => {},
    ...overrides,
  };
}

function nodeById(id: string) {
  const node = behaviourTreeNodes.find((entry) => entry.id === id);
  expect(node, `missing catalog node ${id}`).toBeDefined();
  return node!;
}

describe("behaviour-tree nodes", () => {
  it("registers activate, tick, abort, evaluate, finish, return, and blackboard", () => {
    expect(behaviourTreeNodes.map((node) => node.id)).toEqual([
      "bt.event.activate",
      "bt.event.tick",
      "bt.event.abort",
      "bt.event.evaluate",
      "bt.finish",
      "bt.returnCondition",
      "bt.blackboard.get",
      "bt.blackboard.set",
    ]);
  });

  it("keeps On Evaluate as exec-out only so the graph returns via Return Condition", () => {
    const pins = nodeById("bt.event.evaluate").pins({});
    expect(pins.map((pin) => pin.id)).toEqual(["execOut"]);
  });

  it("emits ctx.btEvaluate from Return Condition", () => {
    const emits: string[] = [];
    nodeById("bt.returnCondition").codegen(
      mockCtx({
        input: () => "false",
        emit: (s) => {
          emits.push(s);
        },
      }),
    );
    expect(emits.some((line) => line.includes("ctx.btEvaluate(false)"))).toBe(
      true,
    );
  });

  it("emits getBlackboard / setBlackboard from the blackboard nodes", () => {
    const get = nodeById("bt.blackboard.get").codegen(
      mockCtx({ input: () => '"alert"' }),
    );
    expect(get).toEqual({ out: 'ctx.getBlackboard("alert")' });

    const emits: string[] = [];
    nodeById("bt.blackboard.set").codegen(
      mockCtx({
        input: (name) => (name === "key" ? '"alert"' : "true"),
        emit: (s) => {
          emits.push(s);
        },
      }),
    );
    expect(
      emits.some((line) => line.includes('ctx.setBlackboard("alert", true)')),
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { EngineObject } from "@haptic/object-model";
import { copyBlackboard, sameBlackboard } from "./bt-blackboard";

/** A hang cannot be interrupted, but a copy that takes exponentially long fails here on any run that finishes. */
const QUICK = { timeout: 2_000 };

const unchangedAfterCopy = (board: Record<string, unknown>) => sameBlackboard(copyBlackboard(board), board);

describe("Blackboard baseline copy", () => {
  it("compares acyclic plain data by content, including NaN and nested edits", () => {
    const board = { list: [1, [2, Number.NaN]] as [number, number[]], nested: { name: "x", tags: ["a"] }, flag: undefined };
    const copy = copyBlackboard(board);
    expect(sameBlackboard(copy, board)).toBe(true);
    board.nested.tags.push("b");
    expect(sameBlackboard(copy, board)).toBe(false);
    const again = copyBlackboard(board);
    board.list[1][0] = 3;
    expect(sameBlackboard(again, board)).toBe(false);
  });

  it("compares live objects by identity, never by their contents", () => {
    const actor = new EngineObject({ classId: "Actor", guid: "a" });
    const board = { target: actor };
    expect(sameBlackboard(copyBlackboard(board), board)).toBe(true);
    expect(sameBlackboard(copyBlackboard(board), { target: new EngineObject({ classId: "Actor", guid: "a" }) })).toBe(false);
  });

  it("never claims unchanged a value with a Map, a class instance or a function", () => {
    class Point { x = 1; }
    for (const value of [new Map([["a", 1]]), new Point(), () => 1, new Date(0)]) {
      expect(unchangedAfterCopy({ value }), String(value)).toBe(false);
    }
  });

  it("leaves a throwing getter to sanitizing instead of throwing from the tick", () => {
    const board = { get boom(): number { throw new Error("getter"); } };
    expect(() => copyBlackboard(board)).not.toThrow();
    expect(unchangedAfterCopy(board)).toBe(false);
  });

  it("does not loop on an object with several references back to itself", QUICK, () => {
    const node: Record<string, unknown> = {};
    node.self = node;
    node.other = node;
    expect(unchangedAfterCopy({ node })).toBe(false);
  });

  it("does not blow up on a doubly linked chain", QUICK, () => {
    const chain: Array<Record<string, unknown>> = Array.from({ length: 40 }, (_, index) => ({ index }));
    chain.forEach((node, index) => {
      if (index > 0) node.prev = chain[index - 1];
      if (index < chain.length - 1) node.next = chain[index + 1];
    });
    expect(unchangedAfterCopy({ head: chain[0] })).toBe(false);
  });

  it("does not blow up on a tree whose nodes point at their parent and siblings", QUICK, () => {
    type Node = { depth: number; parent?: Node; children: Node[] };
    const build = (depth: number, parent?: Node): Node => {
      const node: Node = { depth, parent, children: [] };
      if (depth < 6) node.children.push(build(depth + 1, node), build(depth + 1, node));
      return node;
    };
    expect(unchangedAfterCopy({ root: build(0) })).toBe(false);
  });

  it("does not expand an acyclic structure that shares its nodes exponentially", QUICK, () => {
    let node: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 40; level++) node = { left: node, right: node };
    expect(unchangedAfterCopy({ node })).toBe(false);
  });
});

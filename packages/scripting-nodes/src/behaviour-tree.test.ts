import { describe, expect, it } from "vitest";
import { behaviourTreeNodes } from "./behaviour-tree";

describe("behaviour-tree nodes", () => {
  it("registers activate, tick, abort, evaluate, and finish", () => {
    expect(behaviourTreeNodes.map((node) => node.id)).toEqual([
      "bt.event.activate",
      "bt.event.tick",
      "bt.event.abort",
      "bt.event.evaluate",
      "bt.finish",
    ]);
  });
});

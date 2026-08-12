import { describe, expect, it } from "vitest";
import { NodeRegistry, pin } from "./node-registry";
import { EXEC } from "./types";

describe("NodeRegistry", () => {
  it("registers, lists, and filters by category", () => {
    const registry = new NodeRegistry();
    registry.register({
      id: "flow.entry",
      title: "Entry",
      category: "flow",
      pins: () => [pin("execOut", "then", "out", EXEC)],
      codegen: () => undefined,
    });
    registry.registerAll([
      {
        id: "math.add",
        title: "Add",
        category: "math",
        pins: () => [],
        codegen: () => ({ out: "0" }),
        pure: true,
      },
    ]);

    expect(registry.get("flow.entry")?.title).toBe("Entry");
    expect(registry.list()).toHaveLength(2);
    expect(registry.listByCategory("math").map((d) => d.id)).toEqual([
      "math.add",
    ]);
  });

  it("rejects duplicate node ids", () => {
    const registry = new NodeRegistry();
    const def = {
      id: "dup",
      title: "Dup",
      category: "test",
      pins: () => [],
      codegen: () => undefined,
    };
    registry.register(def);
    expect(() => registry.register(def)).toThrow(/already registered/);
  });
});

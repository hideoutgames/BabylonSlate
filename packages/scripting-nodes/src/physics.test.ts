import { describe, expect, it } from "vitest";
import { createEmptyLogicGraph, type CodegenContext } from "@babylonslate/scripting";
import { physicsNodes } from "./physics";

function emitCtx(): { ctx: CodegenContext; emits: string[] } {
  const emits: string[] = [];
  return {
    emits,
    ctx: {
      graph: createEmptyLogicGraph("g"),
      node: {
        id: "n1",
        typeId: "physics.moveCharacter",
        position: { x: 0, y: 0 },
        pins: [],
        properties: {},
      },
      indent: "  ",
      input: (name) =>
        name === "target"
          ? "actor"
          : name === "translation"
            ? "delta"
            : "0.01",
      output: (name) => `_out_${name}`,
      emit: (s) => {
        emits.push(s);
      },
      hoist: () => {},
      requestAsync: () => {},
    },
  };
}

describe("physics nodes", () => {
  it("exports at least one node definition", () => {
    expect(physicsNodes.length).toBeGreaterThanOrEqual(4);
    expect(physicsNodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "physics.lineTrace",
        "physics.sphereOverlap",
        "physics.shapeSweep",
        "physics.addImpulse",
        "physics.moveCharacter",
      ]),
    );
  });

  it("moveCharacter takes an Actor and emits ctx.moveCharacter", () => {
    const def = physicsNodes.find((n) => n.id === "physics.moveCharacter");
    expect(def).toBeDefined();
    const pins = def!.pins({});
    expect(pins.map((p) => p.id)).toEqual(
      expect.arrayContaining(["target", "translation", "offset"]),
    );
    expect(pins.find((p) => p.id === "target")?.type).toEqual({
      kind: "actorRef",
      classId: "Actor",
    });
    const { ctx, emits } = emitCtx();
    def!.codegen(ctx);
    expect(emits.join("\n")).toContain(
      "ctx.moveCharacter(actor, delta, 0.01)",
    );
    expect(emits.join("\n")).not.toContain("ctx.log");
  });
});

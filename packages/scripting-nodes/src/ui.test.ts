import { describe, expect, it } from "vitest";
import { createEmptyLogicGraph } from "@babylonslate/scripting";
import type { CodegenContext } from "@babylonslate/scripting";
import { uiNodes } from "./ui";

function mockCtx(): CodegenContext & { emits: string[] } {
  const emits: string[] = [];
  return {
    emits,
    graph: createEmptyLogicGraph("g"),
    node: {
      id: "n1",
      typeId: "test",
      position: { x: 0, y: 0 },
      pins: [],
      properties: {},
    },
    indent: "  ",
    input: (name) => `IN_${name}`,
    output: (name) => `_out_${name}`,
    emit: (s) => {
      emits.push(s);
    },
    hoist: () => {},
    requestAsync: () => {},
  };
}

describe("ui nodes", () => {
  it("applies a UserInterface to the viewport and returns an instance ref", () => {
    const apply = uiNodes.find((node) => node.id === "ui.applyToViewport");
    expect(apply?.title).toBe("Apply User Interface");
    const pins = apply!.pins({});
    expect(pins.map((pin) => pin.id)).toEqual([
      "execIn",
      "execOut",
      "asset",
      "instance",
    ]);
    const ctx = mockCtx();
    apply!.codegen(ctx);
    expect(ctx.emits.join("\n")).toContain(
      "_out_instance = ctx.applyUserInterface(IN_asset)",
    );
  });

  it("removes an applied UserInterface by instance ref", () => {
    const remove = uiNodes.find((node) => node.id === "ui.removeFromViewport");
    expect(remove?.title).toBe("Remove User Interface");
    const pins = remove!.pins({});
    expect(pins.map((pin) => pin.id)).toEqual(["execIn", "execOut", "instance"]);
    const ctx = mockCtx();
    remove!.codegen(ctx);
    expect(ctx.emits.join("\n")).toContain(
      "ctx.removeUserInterface(IN_instance)",
    );
  });
});

import { describe, expect, it } from "vitest";
import { createEmptyLogicGraph, type CodegenContext } from "@babylonslate/scripting";
import { debugNodes, isValidJsIdentifier } from "./debug";

describe("debug nodes", () => {
  it("exports at least one node definition", () => {
    expect(debugNodes.length).toBeGreaterThan(0);
    expect(debugNodes[0]?.id).toBeTruthy();
    expect(debugNodes[0]?.category).toBeTruthy();
  });
});

describe("isValidJsIdentifier", () => {
  it("accepts normal identifiers and rejects reserved or invalid names", () => {
    expect(isValidJsIdentifier("value")).toBe(true);
    expect(isValidJsIdentifier("_ok")).toBe(true);
    expect(isValidJsIdentifier("await")).toBe(false);
    expect(isValidJsIdentifier("ctx")).toBe(false);
    expect(isValidJsIdentifier("1bad")).toBe(false);
    expect(isValidJsIdentifier("has-dash")).toBe(false);
  });
});

describe("debug.executeJavaScript codegen", () => {
  function collectCtx(
    properties: Record<string, unknown>,
  ): { emits: string[]; hoists: string[]; ctx: CodegenContext } {
    const emits: string[] = [];
    const hoists: string[] = [];
    const def = debugNodes.find((d) => d.id === "debug.executeJavaScript")!;
    const pins = def.pins(properties);
    const ctx: CodegenContext = {
      graph: createEmptyLogicGraph("g"),
      node: {
        id: "js1",
        typeId: "debug.executeJavaScript",
        position: { x: 0, y: 0 },
        pins,
        properties,
      },
      indent: "  ",
      input: (name) => `_in_${name}`,
      output: (name) => `_out_${name}`,
      emit: (s) => {
        emits.push(s);
      },
      hoist: (s) => {
        hoists.push(s);
      },
    };
    return { emits, hoists, ctx };
  }

  it("hoists a function and assigns outputs for valid pin names", () => {
    const properties = {
      body: "b = a + 1;",
      inputs: [{ name: "a", type: { kind: "float" } }],
      outputs: [{ name: "b", type: { kind: "float" } }],
    };
    const { emits, hoists, ctx } = collectCtx(properties);
    debugNodes
      .find((d) => d.id === "debug.executeJavaScript")!
      .codegen(ctx);

    expect(hoists[0]).toContain("function execJs_js1(a)");
    expect(hoists[0]).toContain("b = a + 1;");
    expect(emits.some((e) => e.includes("const __r ="))).toBe(true);
    expect(emits.some((e) => e.includes("_out_b = __r.b"))).toBe(true);
  });

  it("emits a throw when a pin name is not a valid JS identifier", () => {
    const properties = {
      body: "return;",
      inputs: [{ name: "await", type: { kind: "float" } }],
      outputs: [],
    };
    const { emits, hoists, ctx } = collectCtx(properties);
    debugNodes
      .find((d) => d.id === "debug.executeJavaScript")!
      .codegen(ctx);

    expect(hoists).toHaveLength(0);
    expect(emits[0]).toMatch(/Invalid JS identifier: await/);
  });
});

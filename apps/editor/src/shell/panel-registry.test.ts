import { describe, expect, it } from "vitest";
import { panelComponents } from "./panel-registry";

describe("panelComponents", () => {
  it("registers Animation Graph dock panels", () => {
    expect(panelComponents["anim-graph-graph"]).toBeTypeOf("function");
    expect(panelComponents["anim-graph-parameters"]).toBeTypeOf("function");
    expect(panelComponents["anim-graph-details"]).toBeTypeOf("function");
  });

  it("registers Behaviour Tree dock panels", () => {
    expect(panelComponents["behaviour-tree-graph"]).toBeTypeOf("function");
    expect(panelComponents["behaviour-tree-details"]).toBeTypeOf("function");
  });
});

import { describe, expect, it } from "vitest";
import { panelComponents } from "./panel-registry";

describe("panelComponents", () => {
  it("registers Animation Graph dock panels", () => {
    expect(panelComponents["anim-graph-graph"]).toBeTypeOf("function");
    expect(panelComponents["anim-graph-variables"]).toBeTypeOf("function");
    expect(panelComponents["anim-graph-details"]).toBeTypeOf("function");
    expect(panelComponents["anim-graph-compiler-results"]).toBeTypeOf("function");
    expect(panelComponents["anim-object-graph"]).toBeTypeOf("function");
    expect(panelComponents["anim-object-variables"]).toBeTypeOf("function");
    expect(panelComponents["anim-object-inspector"]).toBeTypeOf("function");
  });

  it("registers Behaviour Tree dock panels", () => {
    expect(panelComponents["behaviour-tree-graph"]).toBeTypeOf("function");
    expect(panelComponents["behaviour-tree-details"]).toBeTypeOf("function");
    expect(panelComponents["behaviour-tree-blackboard"]).toBeTypeOf("function");
    expect(panelComponents["behaviour-tree-compiler-results"]).toBeTypeOf(
      "function",
    );
  });

  it("registers imported Audio Preview, Details, and Clips docks", () => {
    expect(panelComponents["audio-preview"]).toBeTypeOf("function");
    expect(panelComponents["audio-details"]).toBeTypeOf("function");
    expect(panelComponents["audio-clips"]).toBeTypeOf("function");
  });

  it("registers Audio Mixer, Channel, and Attenuation details docks", () => {
    expect(panelComponents["audio-mixer-details"]).toBeTypeOf("function");
    expect(panelComponents["audio-channel-details"]).toBeTypeOf("function");
    expect(panelComponents["sound-attenuation-details"]).toBeTypeOf("function");
  });

  it("registers Particle Emitter and Particle System Preview and Details docks", () => {
    expect(panelComponents["particle-emitter-preview"]).toBeTypeOf("function");
    expect(panelComponents["particle-emitter-details"]).toBeTypeOf("function");
    expect(panelComponents["particle-system-preview"]).toBeTypeOf("function");
    expect(panelComponents["particle-system-details"]).toBeTypeOf("function");
  });
});

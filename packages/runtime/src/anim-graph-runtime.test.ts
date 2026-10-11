import { describe, expect, it, vi } from "vitest";
import { createDefaultAnimGraph, type AnimGraphDocument } from "@babylonslate/anim-graph";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { AnimGraphRuntime } from "./anim-graph-runtime";

function setup(document: AnimGraphDocument, count = 1) {
  const actors = Array.from({ length: count }, () => {
    const actor = new Actor({ classId: "Hero" });
    actor.attachComponent(new ActorComponent({ classId: "AnimationGraphComponent", variables: { graphGuid: "graph" } }));
    return actor;
  });
  const gate = { canTick: true, playAnimationOwns: false };
  const invokeAnimEvent = vi.fn();
  const runtime = new AnimGraphRuntime({
    actors: () => actors,
    stopped: () => false,
    canTick: () => gate.canTick,
    slot: (actor) => actors.indexOf(actor),
    hasRenderSlot: () => true,
    playAnimationOwns: () => gate.playAnimationOwns,
    scripts: () => ({ invokeAnimEvent, invokeAnimRule: vi.fn() }),
    setSpriteClip: () => {},
    emit: () => {},
  });
  runtime.register("graph", document);
  return { actors, gate, invokeAnimEvent, runtime };
}

describe("AnimGraphRuntime", () => {
  it.each(["canTick", "playAnimationOwns"] as const)("resumes a graph skipped for one tick (%s) without initializing it again", (skip) => {
    const { gate, invokeAnimEvent, runtime } = setup(createDefaultAnimGraph());
    runtime.tick(0.1);
    if (skip === "canTick") gate.canTick = false;
    else gate.playAnimationOwns = true;
    runtime.tick(0.1);
    gate.canTick = true;
    gate.playAnimationOwns = false;
    runtime.tick(0.1);

    expect(invokeAnimEvent.mock.calls.filter(([, event]) => event === "onInitializeAnimation")).toHaveLength(1);
    const state = runtime.traceStates()[0]?.state as { timeMs?: number } | undefined;
    expect(state?.timeMs).toBeCloseTo(200);
  });

  it("starts a component switched to another graph at that graph's entry state without the old graph's jump", () => {
    const withRun = (name: string) => {
      const document = createDefaultAnimGraph(name);
      document.states.push({ ...document.states[0]!, id: "run", name: "Run" });
      return document;
    };
    const { actors, invokeAnimEvent, runtime } = setup(withRun("First"));
    runtime.register("second", withRun("Second"));
    const component = actors[0]!.components[0]!;
    runtime.tick(0.1);
    runtime.tick(0.1);
    runtime.control(component)!.jumpToState("Run");
    component.setVariable("graphGuid", "second");
    runtime.tick(0.1);

    expect(runtime.traceStates()).toEqual([{
      componentGuid: component.guid,
      graphGuid: "second",
      state: expect.objectContaining({ stateId: "idle", timeMs: expect.closeTo(100) }),
    }]);
    expect(invokeAnimEvent.mock.calls.filter(([, event]) => event === "onInitializeAnimation")).toHaveLength(2);
  });

  it("gives each component its own copy of an object variable default", () => {
    const document = createDefaultAnimGraph();
    const tags = { Tags: ["Idle"] };
    document.variables.push(
      { id: "tags", name: "Tags", typeId: "struct", typeClassId: "engine:TagContainer", defaultValue: tags },
      { id: "custom", name: "Custom", typeId: "struct", typeClassId: "project:Stats" },
    );
    const { actors, runtime } = setup(document, 2);
    runtime.tick(0.1);

    const [first, second] = actors.map((actor) => actor.components[0]!);
    expect(first!.getVariable("Tags")).toEqual(tags);
    expect(first!.getVariable("Tags")).not.toBe(tags);
    expect(second!.getVariable("Tags")).not.toBe(first!.getVariable("Tags"));
    expect(first!.getVariable("Custom")).toEqual({});
  });
});

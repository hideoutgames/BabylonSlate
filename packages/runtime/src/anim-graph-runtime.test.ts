import { describe, expect, it, vi } from "vitest";
import {
  ANIM_POSE_OUTPUT_NODE_ID,
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  type AnimGraphDocument,
} from "@haptic/anim-graph";
import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, type CommandMessage } from "@haptic/bridge";
import { Actor, ActorComponent, ClassRegistry, World } from "@haptic/object-model";
import { AnimGraphRuntime } from "./anim-graph-runtime";
import { ScriptBreakpoints, type BreakpointHit } from "./script-breakpoints";
import type { SlotClipLoad, SlotClipLoader } from "./script-host";

function setup(document: AnimGraphDocument, count = 1, breakpoints = new ScriptBreakpoints(() => {})) {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actors = Array.from({ length: count }, () => {
    const actor = new Actor({ classId: "Hero" });
    actor.attachComponent(new ActorComponent({ classId: "AnimationGraphComponent", variables: { graphGuid: "graph" } }));
    return world.spawnActorNow(actor);
  });
  const gate = { canTick: true, playAnimationOwns: false };
  const invokeAnimEvent = vi.fn();
  const setSpriteClip = vi.fn();
  const playEventSound = vi.fn();
  const spawnEventParticles = vi.fn();
  const applyRootMotion = vi.fn();
  const emitted: CommandMessage[] = [];
  const runtime = new AnimGraphRuntime({
    world: () => world,
    stopped: () => false,
    canTick: () => gate.canTick,
    slot: (actor) => actors.indexOf(actor),
    hasRenderSlot: () => true,
    playAnimationOwns: () => gate.playAnimationOwns,
    scripts: () => ({ invokeAnimEvent, invokeAnimRule: vi.fn(), invokeAnimPose: vi.fn() }),
    setSpriteClip,
    breakpoints: () => breakpoints,
    frameTrace: () => null,
    emit: (command) => emitted.push(command),
    playEventSound,
    spawnEventParticles,
    applyRootMotion,
  });
  runtime.register("graph", document);
  return { actors, applyRootMotion, emitted, gate, invokeAnimEvent, playEventSound, runtime, setSpriteClip, spawnEventParticles };
}

describe("AnimGraphRuntime", () => {
  it("moves each actor by its graph's root motion every tick", () => {
    const document = createDefaultAnimGraph();
    const idle = document.stateMachine.states[0]!;
    idle.stateGraph.nodes = idle.stateGraph.nodes.map((node) =>
      node.id === "player"
        ? {
            ...node,
            data: {
              ...node.data,
              assetGuid: "walk",
              durationMs: 1000,
              rootMotion: { bone: "hips", track: { durationMs: 1000, stepMs: 500, x: [0, 0, 0], z: [0, 1, 2], yaw: [0, 0, 0] } },
            },
          }
        : node);
    const { actors, applyRootMotion, emitted, runtime } = setup(document);
    runtime.tick(0.1);
    runtime.tick(0.1);
    expect(applyRootMotion).toHaveBeenLastCalledWith(actors[0], expect.objectContaining({ x: 0, yaw: 0 }), 0.1);
    expect(applyRootMotion.mock.lastCall?.[1].z).toBeCloseTo(0.2, 9);
    // Render holds the bone in place.
    const state = [...emitted].reverse().find((command: CommandMessage) => command.type === "animState");
    expect(state?.type === "animState" ? state.layers?.[0]?.rootMotionBone : undefined).toBe("hips");
  });

  it("runs each fired Animation Event in the graph's Animation Object, after its own action", () => {
    const document = createDefaultAnimGraph();
    const idle = document.stateMachine.states[0]!;
    idle.events = { enter: "Idle Started" };
    idle.stateGraph.nodes = idle.stateGraph.nodes.map((node) =>
      node.id === "player"
        ? {
            ...node,
            data: {
              ...node.data,
              assetGuid: "walk",
              durationMs: 1000,
              events: [
                { name: "Footstep", timeMs: 50, durationMs: 0, triggerWeight: 0.5, action: { kind: "playSound", assetGuid: "step", volume: 0.7 } },
                { name: "Dust", timeMs: 80, durationMs: 0, triggerWeight: 0.5, action: { kind: "spawnParticles", assetGuid: "dust", bone: "foot_l" } },
              ],
            },
          }
        : node);
    const { actors, invokeAnimEvent, playEventSound, runtime, spawnEventParticles } = setup(document);
    runtime.tick(0.1);
    const notifies = invokeAnimEvent.mock.calls.filter(([, event]) => event === "onAnimNotify");
    expect(notifies.map(([classId, , self, , , args]) => [classId, self, args])).toEqual([
      ["AnimGraph:graph", actors[0], { name: "Idle Started", phase: "event", animation: "" }],
      ["AnimGraph:graph", actors[0], { name: "Footstep", phase: "event", animation: "walk" }],
      ["AnimGraph:graph", actors[0], { name: "Dust", phase: "event", animation: "walk" }],
    ]);
    expect(playEventSound).toHaveBeenCalledWith(actors[0], "step", 0.7);
    expect(spawnEventParticles).toHaveBeenCalledWith(actors[0], "dust", "foot_l");
    // Nothing is crossed again until the next pass.
    invokeAnimEvent.mockClear();
    runtime.tick(0.1);
    expect(invokeAnimEvent.mock.calls.filter(([, event]) => event === "onAnimNotify")).toEqual([]);
  });

  it("follows its Tick Mode: Never stops the graph where it is, When Visible runs it and asks render to pose only in view", () => {
    const document = createDefaultAnimGraph();
    document.stateMachine.states[0]!.events = { enter: "Idle Started" };
    const { actors, emitted, invokeAnimEvent, runtime } = setup(document);
    const component = actors[0]!.components[0]!;
    const notifies = () => invokeAnimEvent.mock.calls.filter(([, event]) => event === "onAnimNotify").length;
    component.setVariable("tickMode", "never");
    runtime.tick(0.1);
    expect(emitted).toEqual([]);
    expect(notifies()).toBe(0);
    expect(invokeAnimEvent).not.toHaveBeenCalled();
    component.setVariable("tickMode", "whenVisible");
    runtime.tick(0.1);
    expect(notifies()).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "animState", slotId: 0, normalisedTime: expect.any(Number), whenVisible: true });
    component.setVariable("tickMode", "always");
    runtime.tick(0.1);
    expect(emitted[1]).not.toHaveProperty("whenVisible");
  });

  it("stops on a state when the graph starts in it, jumps to it or enters it, and on a transition it takes", () => {
    const document = createDefaultAnimGraph();
    const machine = document.stateMachine;
    machine.states.push({ ...machine.states[0]!, id: "run", name: "Run" });
    // A rule that decides nothing passes, so Idle goes to Run on every tick it is in Idle.
    machine.transitions.push({
      id: "go", fromStateId: "idle", toStateId: "run", blendSeconds: 0, priority: 0, ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const hits: BreakpointHit[] = [];
    const breakpoints = new ScriptBreakpoints((hit) => hits.push(hit));
    breakpoints.set(["idle", "go", "run"].map((nodeId) => ({ assetGuid: "graph", graphId: ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, nodeId })));
    const { actors, runtime } = setup(document, 1, breakpoints);
    const component = actors[0]!.components[0]!;
    const stops = () => hits.map(({ nodeId, event }) => `${nodeId} ${event}`);

    runtime.tick(0.1);
    expect(stops()).toEqual(["idle entered", "go taken", "run entered"]);
    expect(hits[0]).toMatchObject({ assetGuid: "graph", graphId: ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, instance: component, owner: actors[0] });

    hits.length = 0;
    runtime.tick(0.1);
    expect(stops()).toEqual([]);

    runtime.control(component)!.jumpToState("Idle");
    runtime.tick(0.1);
    expect(stops()).toEqual(["idle entered", "go taken", "run entered"]);
  });

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
      const machine = document.stateMachine;
      machine.states.push({ ...machine.states[0]!, id: "run", name: "Run" });
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

  it("hands the sprite collider the frame a 2D graph shows, mirrored by Flip Frame", () => {
    const document = createDefaultAnimGraph("Robot", { dimension: "2d" });
    document.stateMachine.states[0]!.stateGraph = {
      nodes: [
        { id: "flip", type: "anim.frame.flip", position: { x: 0, y: 0 }, data: { "default:flipX": true } },
        { id: "walk", type: "anim.frame.spritePlayer", position: { x: 0, y: 0 }, data: { assetGuid: "walk", durationMs: 400 } },
        { id: ANIM_POSE_OUTPUT_NODE_ID, type: "anim.frame.output", position: { x: 0, y: 0 }, data: { __protected: true } },
      ],
      edges: [
        { id: "a", source: "walk", sourceHandle: "pose", target: "flip", targetHandle: "frame" },
        { id: "b", source: "flip", sourceHandle: "pose", target: ANIM_POSE_OUTPUT_NODE_ID, targetHandle: "frame" },
      ],
    };
    const { actors, runtime, setSpriteClip } = setup(document);
    runtime.tick(0.1);
    expect(setSpriteClip).toHaveBeenLastCalledWith(actors[0], {
      assetGuid: "walk", clipName: "", normalisedTime: expect.closeTo(0.25), stateId: "idle", flipX: true,
    });
  });
});

describe("AnimGraphRuntime slots", () => {
  /** The default graph with its player wired through a Slot into the output. */
  function slottedGraph(): AnimGraphDocument {
    const document = createDefaultAnimGraph();
    const graph = document.stateMachine.states[0]!.stateGraph;
    graph.nodes.push({ id: "slot", type: "anim.pose.slot", position: { x: 0, y: 0 }, data: {} });
    graph.edges = [
      { id: "player->slot", source: "player", sourceHandle: "pose", target: "slot", targetHandle: "source" },
      { id: "slot->output", source: "slot", sourceHandle: "pose", target: ANIM_POSE_OUTPUT_NODE_ID, targetHandle: "pose" },
    ];
    return document;
  }
  const catalog = [{ guid: "swing", type: "Animation", name: "Swing", clipName: "swing", durationMs: 300 }];
  /** Records a wait's answer as it settles: at once for a plain answer, else inside the tick that settles it. */
  const settle = (wait: PromiseLike<boolean> | boolean, record: (value: boolean) => void) => {
    if (typeof wait === "boolean") record(wait);
    else wait.then(record);
  };
  const request = { animation: "swing", slot: "", blendInSeconds: 0, blendOutSeconds: 0.1, playRate: 1, loopCount: 1, startSeconds: 0 };

  it("plays a slot Animation through the Slot node, and resolves its blend out, then its completion", () => {
    const { actors, emitted, runtime } = setup(slottedGraph());
    runtime.replaceAnimClipCatalog(catalog);
    const control = runtime.control(actors[0]!.components[0]!)!;
    const handle = control.playSlotAnimation(request);
    expect(handle).toBeGreaterThan(0);
    // Queued, it already counts as active.
    expect(control.isSlotActive("DefaultSlot")).toBe(true);
    const order: string[] = [];
    settle(runtime.waitSlot(handle, "blendOut"), (value) => order.push(`blendOut:${value}`));
    runtime.tick(0.1);
    const layers = (emitted.at(-1) as Extract<CommandMessage, { type: "animState" }>).layers ?? [];
    expect(layers.map((layer) => [layer.clipAssetGuid, layer.weight])).toEqual([["swing", 1]]);
    runtime.tick(0.1);
    expect(order).toEqual(["blendOut:true"]);
    settle(runtime.waitSlot(handle, "completed"), (value) => order.push(`completed:${value}`));
    runtime.tick(0.1);
    runtime.tick(0.1);
    expect(order).toEqual(["blendOut:true", "completed:true"]);
    expect(control.isSlotActive("DefaultSlot")).toBe(false);
  });

  it("moves the actor by a slot Animation's root motion track from the catalog, and holds the bone of one without a track", () => {
    const track = { durationMs: 1000, stepMs: 500, x: [0, 0, 0], z: [0, 1, 2], yaw: [0, 0, 0] };
    const { actors, applyRootMotion, emitted, runtime } = setup(slottedGraph());
    runtime.replaceAnimClipCatalog([
      { guid: "dodge", type: "Animation", name: "Dodge", clipName: "dodge", durationMs: 1000, rootMotion: { bone: "hips", track } },
      { guid: "lunge", type: "Animation", name: "Lunge", clipName: "lunge", durationMs: 1000, rootMotion: { bone: "hips" } },
    ]);
    const control = runtime.control(actors[0]!.components[0]!)!;
    control.playSlotAnimation({ ...request, animation: "dodge", loopCount: 0 });
    runtime.tick(0.1);
    runtime.tick(0.1);
    expect(applyRootMotion.mock.lastCall?.[1].z).toBeCloseTo(0.2, 9);
    control.stopSlotAnimation("DefaultSlot", 0);
    runtime.tick(0.1);
    applyRootMotion.mockClear();
    control.playSlotAnimation({ ...request, animation: "lunge", loopCount: 0 });
    runtime.tick(0.1);
    runtime.tick(0.1);
    expect(applyRootMotion).not.toHaveBeenCalled();
    const state = [...emitted].reverse().find((command: CommandMessage) => command.type === "animState");
    expect(state?.type === "animState" ? state.layers?.find((layer) => layer.clipAssetGuid === "lunge")?.rootMotionBone : undefined).toBe("hips");
  });

  it("answers false for a stopped play's completion, and for an Animation it cannot play", () => {
    const { actors, runtime } = setup(slottedGraph());
    runtime.replaceAnimClipCatalog(catalog);
    const control = runtime.control(actors[0]!.components[0]!)!;
    expect(control.playSlotAnimation({ ...request, animation: "missing" })).toBe(0);
    expect(runtime.waitSlot(0, "completed")).toBe(false);
    const handle = control.playSlotAnimation({ ...request, loopCount: 0 });
    runtime.tick(0.1);
    const results: boolean[] = [];
    settle(runtime.waitSlot(handle, "completed"), (value) => results.push(value));
    control.stopSlotAnimation("DefaultSlot", 0);
    runtime.tick(0.1);
    expect(results).toEqual([false]);
  });

  it("ends a destroyed actor's plays, so their waits answer false", () => {
    const { actors, runtime } = setup(slottedGraph());
    runtime.replaceAnimClipCatalog(catalog);
    const handle = runtime.control(actors[0]!.components[0]!)!.playSlotAnimation({ ...request, loopCount: 0 });
    runtime.tick(0.1);
    const results: boolean[] = [];
    settle(runtime.waitSlot(handle, "completed"), (value) => results.push(value));
    runtime.retireActor(actors[0]!);
    expect(results).toEqual([false]);
  });

  it("ends every play when the session stops, and forgets the session's graphs and clips", () => {
    const { actors, runtime } = setup(slottedGraph(), 2);
    runtime.replaceAnimClipCatalog(catalog);
    const handles = actors.map((actor) => runtime.control(actor.components[0]!)!.playSlotAnimation({ ...request, loopCount: 0 }));
    runtime.tick(0.1);
    const results: boolean[] = [];
    for (const handle of handles) settle(runtime.waitSlot(handle, "completed"), (value) => results.push(value));
    runtime.cancelPending();
    // The latent continuations resume (and go) at stop, not never.
    expect(results).toEqual([false, false]);
    expect(runtime.waitSlot(handles[0]!, "completed")).toBe(false);
    runtime.dispose();
    expect(runtime.traceStates()).toEqual([]);
    // Neither the graph nor its clips outlive the session.
    expect(runtime.control(actors[0]!.components[0]!)?.playSlotAnimation(request) ?? 0).toBe(0);
  });

  describe("a clip its owner did not load", () => {
    const clips = [...catalog, { guid: "kick", type: "Animation", name: "Kick", clipName: "kick", durationMs: 300 }];
    /** Loads clips not in `loaded`: each waits until the test settles it, as the host's load would. */
    function clipLoader(loaded: readonly string[] = []) {
      const loads: Array<{ guid: string; play: SlotClipLoad }> = [];
      const loader: SlotClipLoader = {
        needsLoad: (guid) => !loaded.includes(guid),
        loadSlotClip: (_component, guid, play) => { loads.push({ guid, play }); },
      };
      return { loader, loads };
    }
    /** The clips the last evaluation showed (structural `animState`, which `animClocks` keeps unchanged). */
    const shown = (emitted: readonly CommandMessage[]) => {
      const latest = [...emitted].reverse().find((command): command is Extract<CommandMessage, { type: "animState" }> => command.type === "animState");
      return (latest?.layers ?? []).map((layer) => layer.clipAssetGuid).filter(Boolean);
    };
    /** Records how each of a play's waits answers. */
    function outcome(runtime: AnimGraphRuntime, handle: number): string[] {
      const answers: string[] = [];
      settle(runtime.waitSlot(handle, "blendOut"), (value) => answers.push(`blendOut:${value}`));
      settle(runtime.waitSlot(handle, "completed"), (value) => answers.push(`completed:${value}`));
      return answers;
    }
    function slotted() {
      const context = setup(slottedGraph());
      context.runtime.replaceAnimClipCatalog(clips);
      return { ...context, control: context.runtime.control(context.actors[0]!.components[0]!)! };
    }

    it("starts the play once the clip loads, and runs On Blend Out and On Completed from that start", () => {
      const { emitted, runtime, control } = slotted();
      const { loader, loads } = clipLoader();
      const handle = control.playSlotAnimation(request, loader);
      expect(handle).toBeGreaterThan(0);
      expect(loads.map((load) => load.guid)).toEqual(["swing"]);
      expect(control.isSlotActive("DefaultSlot")).toBe(true);
      const answers = outcome(runtime, handle);
      // However long the load takes, nothing plays and neither output runs meanwhile.
      for (let tick = 0; tick < 5; tick++) runtime.tick(0.1);
      expect(shown(emitted)).toEqual([]);
      expect(answers).toEqual([]);
      loads[0]!.play.ready();
      runtime.tick(0.1);
      expect(shown(emitted)).toEqual(["swing"]);
      runtime.tick(0.1);
      expect(answers).toEqual(["blendOut:true"]);
      runtime.tick(0.1);
      runtime.tick(0.1);
      expect(answers).toEqual(["blendOut:true", "completed:true"]);
      expect(control.isSlotActive("DefaultSlot")).toBe(false);
    });

    it("lets a later Play Slot Animation on the slot win: the earlier play ends unstarted and its late load plays nothing", () => {
      const { emitted, runtime, control } = slotted();
      const { loader, loads } = clipLoader();
      const first = control.playSlotAnimation(request, loader);
      const firstAnswers = outcome(runtime, first);
      // A loaded clip supersedes the waiting one at once.
      control.playSlotAnimation({ ...request, animation: "kick", loopCount: 0 }, clipLoader(["kick"]).loader);
      expect(firstAnswers).toEqual(["blendOut:false", "completed:false"]);
      expect(loads[0]!.play.current()).toBe(false);
      loads[0]!.play.ready();
      runtime.tick(0.1);
      runtime.tick(0.1);
      expect(shown(emitted)).toEqual(["kick"]);

      // Two loading plays: the later one plays, whichever load arrives first.
      const second = control.playSlotAnimation(request, loader);
      const third = control.playSlotAnimation({ ...request, animation: "kick" }, clipLoader().loader);
      expect(outcome(runtime, second)).toEqual(["blendOut:false", "completed:false"]);
      expect(third).toBeGreaterThan(second);
      loads[1]!.play.ready();
      runtime.tick(0.1);
      // The slot keeps what it played until its latest request starts.
      expect(shown(emitted)).toEqual(["kick"]);
    });

    it("ends a waiting play on Stop Slot Animation, so its outputs do not run and its late load plays nothing", () => {
      const { emitted, runtime, control } = slotted();
      const { loader, loads } = clipLoader();
      const handle = control.playSlotAnimation(request, loader);
      const answers = outcome(runtime, handle);
      control.stopSlotAnimation("", 0.2);
      expect(answers).toEqual(["blendOut:false", "completed:false"]);
      expect(control.isSlotActive("DefaultSlot")).toBe(false);
      expect(loads[0]!.play.current()).toBe(false);
      loads[0]!.play.ready();
      runtime.tick(0.1);
      runtime.tick(0.1);
      expect(shown(emitted)).toEqual([]);
      // Another slot's waiting play is not stopped.
      const other = control.playSlotAnimation({ ...request, slot: "UpperBody" }, loader);
      control.stopSlotAnimation("DefaultSlot", 0);
      expect(loads[1]!.play.current()).toBe(true);
      expect(outcome(runtime, other)).toEqual([]);
    });

    it("ends a waiting play when its load fails", () => {
      const { emitted, runtime, control } = slotted();
      const { loader, loads } = clipLoader();
      const handle = control.playSlotAnimation(request, loader);
      const answers = outcome(runtime, handle);
      loads[0]!.play.failed();
      expect(answers).toEqual(["blendOut:false", "completed:false"]);
      expect(control.isSlotActive("DefaultSlot")).toBe(false);
      runtime.tick(0.1);
      expect(shown(emitted)).toEqual([]);
    });

    it("ends a waiting play when its actor is destroyed or the session stops, and never starts it later", () => {
      const { emitted, runtime, control, actors } = slotted();
      const { loader, loads } = clipLoader();
      const destroyed = outcome(runtime, control.playSlotAnimation(request, loader));
      runtime.retireActor(actors[0]!);
      expect(destroyed).toEqual(["blendOut:false", "completed:false"]);
      expect(loads[0]!.play.current()).toBe(false);
      loads[0]!.play.ready();
      runtime.tick(0.1);
      expect(shown(emitted)).toEqual([]);

      const { runtime: session, control: live, emitted: sessionEmitted } = slotted();
      const stopped = outcome(session, live.playSlotAnimation(request, loader));
      session.cancelPending();
      expect(stopped).toEqual(["blendOut:false", "completed:false"]);
      expect(loads[1]!.play.current()).toBe(false);
      loads[1]!.play.ready();
      session.tick(0.1);
      expect(shown(sessionEmitted)).toEqual([]);
    });
  });

  it("emits compact binary animClocks on steady-state ticks after the initial structural animState", () => {
    const document = slottedGraph();
    const { actors, emitted, runtime } = setup(document);
    runtime.replaceAnimClipCatalog(catalog);
    runtime.control(actors[0]!.components[0]!)!.playSlotAnimation({ ...request, loopCount: 0 });
    runtime.tick(0.05);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("animState");

    runtime.tick(0.05);
    expect(emitted).toHaveLength(2);
    const clocks = emitted[1];
    expect(clocks?.type).toBe("animClocks");
    if (clocks?.type !== "animClocks") throw new Error("expected animClocks");
    // [slotId, stateNormalisedTime, layerCount, layer0Time, layer0Weight]
    expect(clocks.data[0]).toBe(0);
    expect(clocks.data[1]).toBeCloseTo(0.1, 5);
    expect(clocks.data[2]).toBe(1);
    expect(clocks.data[3]).toBeCloseTo(100 / 300, 5);
    expect(clocks.data[4]).toBeCloseTo(1, 5);
  });

  it("culls off-screen whenVisible evaluation for side-effect-free graphs and catches up with deferredDt on re-entry", () => {
    const document = createDefaultAnimGraph();
    const { actors, emitted, runtime } = setup(document);
    actors[0]!.components[0]!.setVariable("tickMode", "whenVisible");
    // Initial tick runs while visible (default).
    runtime.tick(0.1);
    expect(emitted).toHaveLength(1);

    // Mark slot 0 off-screen: steady-state ticks emit nothing while invisible.
    runtime.setVisibility(new Uint32Array([0]), 0);
    runtime.tick(0.1);
    runtime.tick(0.1);
    expect(emitted).toHaveLength(1);

    // Return slot 0 to view: accumulated deferredDt (0.2s) + current tick (0.1s) catches phase up to 0.4s.
    runtime.setVisibility(new Uint32Array([1]), 0);
    runtime.tick(0.1);
    expect(emitted).toHaveLength(2);
    const clocks = emitted[1];
    expect(clocks?.type).toBe("animClocks");
    if (clocks?.type === "animClocks") expect(clocks.data[1]).toBeCloseTo(0.4, 5);

    // A graph with state/clip events is never culled off-screen so notifies still fire.
    const withEvents = createDefaultAnimGraph();
    withEvents.stateMachine.states[0]!.events = { enter: "Started" };
    const ev = setup(withEvents);
    ev.actors[0]!.components[0]!.setVariable("tickMode", "whenVisible");
    ev.runtime.tick(0.1);
    ev.runtime.setVisibility(new Uint32Array([0]), 0);
    ev.runtime.tick(0.1);
    expect(ev.emitted).toHaveLength(2);
  });
});

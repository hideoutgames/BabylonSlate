import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import {
  ANIM_EVENT_INITIALIZE_TYPE,
  ANIM_EVENT_UPDATE_TYPE,
  ANIM_POSE_OUTPUT_NODE_ID,
  ANIM_RULE_ENTER_TYPE,
  ANIM_RULE_EXIT_TYPE,
  animEvalWithJump,
  animExitTimeReached,
  animGraphMembersFromVariables,
  animPoseGraphs,
  animTransitionEdgeId,
  animTransitionFromDrag,
  createAnimGraphGraph,
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  createStateGraph,
  decorateTransitionRuleGraph,
  evaluateAnimGraph,
  flipTransitionDirection,
  hydrateAnimGraphForEditor,
  parseAnimGraphDocument,
  patchTransition,
  persistTransitionRuleGraph,
  primaryPosePlayer,
  primaryStateMachine,
  resolveAnimGraphClips,
  serializedToStateMachine,
  setTransitionBidirectional,
  singlePlayerOf,
  stateMachineToSerialized,
  validateAnimGraph,
  type AnimClipCatalogEntry,
  type AnimEvalState,
  type AnimGraphDimension,
  type AnimGraphDocument,
  type AnimGraphInputs,
  type AnimState,
  type AnimStateMachine,
  type AnimTransition,
  type PosePlayerSettings,
} from "./index";

type GraphNode = SerializedGraph["nodes"][number];
type GraphEdge = SerializedGraph["edges"][number];

/** A state that plays one clip, `<id>-clip`, one second long. */
function state(id: string, settings: PosePlayerSettings = {}): AnimState {
  return {
    id,
    name: id.replace(/^./, (first) => first.toUpperCase()),
    position: { x: 0, y: 0 },
    stateGraph: createStateGraph("3d", { assetGuid: `${id}-clip`, clipName: id, durationMs: 1000, ...settings }),
  };
}

function transition(id: string, fromStateId: string, toStateId: string, extra: Partial<AnimTransition> = {}): AnimTransition {
  return { id, fromStateId, toStateId, blendSeconds: 0, priority: 0, ruleGraph: createDefaultTransitionRuleGraph(), ...extra };
}

/** A document whose Anim Graph plays one State Machine, `locomotion`. */
function machineDoc(states: AnimState[], transitions: AnimTransition[] = [], entryStateId = states[0]?.id ?? ""): AnimGraphDocument {
  return {
    ...createDefaultAnimGraph(),
    stateMachines: [{ id: "locomotion", name: "Locomotion", entryStateId, states, transitions }],
  };
}

/** A pose graph of `nodes` whose first node feeds a protected output. */
function poseGraph(dimension: AnimGraphDimension, nodes: GraphNode[], edges: GraphEdge[] = []): SerializedGraph {
  const pin = dimension === "3d" ? "pose" : "frame";
  const output: GraphNode = {
    id: ANIM_POSE_OUTPUT_NODE_ID,
    type: dimension === "3d" ? "anim.pose.output" : "anim.frame.output",
    position: { x: 400, y: 0 },
    data: { __protected: true },
  };
  const root = nodes[0];
  return {
    nodes: [...nodes, output],
    edges: root ? [...edges, wire(root.id, output.id, pin)] : edges,
  };
}

function node(id: string, type: string, data: Record<string, unknown> = {}): GraphNode {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function wire(source: string, target: string, targetHandle: string): GraphEdge {
  return { id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "pose", target, targetHandle };
}

function player(id: string, data: Record<string, unknown> = {}): GraphNode {
  return node(id, "anim.pose.sequencePlayer", { assetGuid: id, clipName: id, durationMs: 1000, loop: true, ...data });
}

/** Runs `ticks` evaluations of `dt` seconds from `from`. */
function run(doc: AnimGraphDocument, dt: number, ticks: number, inputs: AnimGraphInputs = {}, from: AnimEvalState | null = null): AnimEvalState {
  let current = from;
  for (let tick = 0; tick < ticks; tick += 1) current = evaluateAnimGraph(doc, current, dt, inputs);
  return current!;
}

/** Every rule closed. */
const closed: AnimGraphInputs = { decideTransition: () => ({ enter: false, exit: true }) };

const weightsByGuid = (current: AnimEvalState) =>
  Object.fromEntries(current.layers.map((layer) => [layer.clipAssetGuid, Number(layer.weight.toFixed(3))]));

describe("anim graph evaluator: State Machines", () => {
  it("stays on the looping entry clip and wraps time", () => {
    const next = run(machineDoc([state("idle")]), 0.6, 2, closed);
    expect(next.stateId).toBe("idle");
    expect(next.normalisedTime).toBeCloseTo(0.2);
    expect(next.loopCount).toBe(1);
    expect(next.layers).toEqual([
      expect.objectContaining({ stateId: "idle", clipAssetGuid: "idle-clip", clipName: "idle", clipKind: "animation", weight: 1 }),
    ]);
    expect(next.layers[0]!.normalisedTime).toBeCloseTo(0.2);
  });

  it("holds the pose at Play Rate 0 and scales the clock by any other rate", () => {
    expect(run(machineDoc([state("idle", { playRate: 0 })]), 0.25, 1, closed).normalisedTime).toBe(0);
    expect(run(machineDoc([state("idle", { playRate: 2 })]), 0.25, 1, closed).normalisedTime).toBeCloseTo(0.5);
  });

  it("transitions when the rule decides enter and exit, and reports each transition taken", () => {
    const doc = machineDoc([state("idle"), state("run")], [transition("idle-to-run", "idle", "run"), transition("run-to-run", "run", "run")]);
    const taken: string[] = [];
    let decision = { enter: true, exit: false };
    const inputs: AnimGraphInputs = { decideTransition: () => decision, transitionTaken: (row) => taken.push(row.id) };
    expect(evaluateAnimGraph(doc, null, 0.1, inputs).stateId).toBe("idle");
    decision = { enter: true, exit: true };
    const next = evaluateAnimGraph(doc, null, 0.1, inputs);
    expect(next.stateId).toBe("run");
    // A self-transition restarts the state.
    const again = evaluateAnimGraph(doc, run(doc, 0.3, 1, closed, next), 0.1, inputs);
    expect(again.stateId).toBe("run");
    expect(again.normalisedTime).toBe(0);
    expect(taken).toEqual(["idle-to-run", "run-to-run"]);
  });

  it("never fires a transition to a missing state, and enters the first state when the entry is missing", () => {
    const doc = machineDoc([state("idle")], [transition("idle-to-ghost", "idle", "ghost")], "gone");
    expect(evaluateAnimGraph(doc, null, 0.1, {}).stateId).toBe("idle");
  });

  it("clamps a non-looping clip at the end and reports Just Finished once", () => {
    const doc = machineDoc([state("idle", { loop: false })]);
    const finished = run(doc, 0.6, 2, closed);
    expect(finished.normalisedTime).toBe(1);
    expect(finished.facts.justFinished).toBe(true);
    expect(run(doc, 0.6, 1, closed, finished).facts.justFinished).toBe(false);
  });

  it("reports Just Looped when a looping clip wraps, counting several wraps in one tick", () => {
    const looped = run(machineDoc([state("idle", { durationMs: 100 })]), 0.35, 1, closed);
    expect(looped.facts.justLooped).toBe(true);
    expect(looped.loopCount).toBe(3);
  });

  it("crossfades into weighted clip layers over the blend time captured when the transition started", () => {
    const doc = machineDoc([state("idle"), state("run")], [transition("idle-to-run", "idle", "run", { blendSeconds: 0.4 })]);
    const once: AnimGraphInputs = { decideTransition: (row) => ({ enter: row.id === "idle-to-run", exit: true }) };
    const started = evaluateAnimGraph(doc, null, 0.1, once);
    expect(started.stateId).toBe("run");
    expect(started.blendFromStateId).toBe("idle");
    // A later edit to the transition does not change the blend in progress.
    const edited = patchTransition(doc, "idle-to-run", { blendSeconds: 2 });
    const mid = evaluateAnimGraph(edited, started, 0.1, closed);
    expect(Object.fromEntries(mid.layers.map((layer) => [layer.stateId, layer.weight]))).toEqual({
      idle: expect.closeTo(0.5),
      run: expect.closeTo(0.5),
    });
    expect(mid.blendWeights).toEqual({ idle: expect.closeTo(0.5), run: expect.closeTo(0.5) });
    const done = run(doc, 0.1, 3, closed, mid);
    expect(done.blendFromStateId).toBeNull();
    expect(done.layers).toEqual([expect.objectContaining({ stateId: "run", weight: 1 })]);
  });

  it("takes the lowest-priority outgoing transition when several pass", () => {
    const doc = machineDoc([state("idle"), state("walk"), state("run")], [
      transition("idle-to-run", "idle", "run", { priority: 2 }),
      transition("idle-to-walk", "idle", "walk", { priority: 1 }),
    ]);
    expect(evaluateAnimGraph(doc, null, 0.1, {}).stateId).toBe("walk");
  });

  it("asks a rule with the facts after this tick's advance", () => {
    const doc = machineDoc([state("idle", { loop: false })], [transition("idle-to-idle", "idle", "idle")]);
    const seen: boolean[] = [];
    run(doc, 0.6, 2, {
      decideTransition: (_row, facts) => {
        seen.push(facts.justFinished);
        return { enter: false, exit: true };
      },
    });
    expect(seen).toEqual([false, true]);
  });

  it("jumps into a state fresh, and ignores a jump to a missing state", () => {
    const doc = machineDoc([state("idle"), state("run")]);
    const settled = run(doc, 0.3, 2, closed);
    const next = evaluateAnimGraph(doc, animEvalWithJump(doc, settled, "run"), 0.1, closed);
    expect(next.stateId).toBe("run");
    expect(next.normalisedTime).toBeCloseTo(0.1);
    expect(next.blendFromStateId).toBeNull();
    expect(animEvalWithJump(doc, settled, "missing")).toBe(settled);
  });
});

describe("anim graph exit time", () => {
  function exitTimeDoc(options: { loop: boolean; durationMs: number }): AnimGraphDocument {
    return machineDoc([state("idle", options), state("run")], [transition("idle-to-run", "idle", "run")]);
  }

  /** The 1-based tick that entered Run, or null. */
  function tickEnteringRun(
    doc: AnimGraphDocument,
    dtSeconds: number,
    ticks: number,
    exitTime: number,
    open: (tick: number) => boolean = () => true,
  ): number | null {
    let current: AnimEvalState | null = null;
    for (let tick = 1; tick <= ticks; tick += 1) {
      current = evaluateAnimGraph(doc, current, dtSeconds, {
        decideTransition: (_row, facts) => ({ enter: open(tick) && animExitTimeReached(facts, exitTime), exit: true }),
      });
      if (current.stateId === "run") return tick;
    }
    return null;
  }

  it("fires a looping exit time of 1 on the tick that completes the loop", () => {
    expect(tickEnteringRun(exitTimeDoc({ loop: true, durationMs: 1000 }), 0.1, 12, 1)).toBe(10);
  });

  it("fires a looping exit time the clip skips over when it wraps", () => {
    expect(tickEnteringRun(exitTimeDoc({ loop: true, durationMs: 300 }), 1 / 60, 30, 0.95)).toBe(18);
  });

  it("waits for the next loop's crossing when the rule's other input opens late", () => {
    expect(tickEnteringRun(exitTimeDoc({ loop: true, durationMs: 1000 }), 0.1, 20, 0.5, (tick) => tick >= 7)).toBe(15);
  });

  it("keeps a reached exit time open on a finished non-looping clip", () => {
    expect(tickEnteringRun(exitTimeDoc({ loop: false, durationMs: 1000 }), 0.1, 20, 0.5, (tick) => tick >= 15)).toBe(15);
  });

  it.each([
    { exitTime: 0.5, from: 2.4, to: 2.6, looping: true, want: true },
    { exitTime: 0.5, from: 2.6, to: 2.9, looping: true, want: false },
    { exitTime: 1.5, from: 1.4, to: 1.6, looping: true, want: true },
    { exitTime: 1.5, from: 2.4, to: 2.6, looping: true, want: false },
    { exitTime: 0, from: 0, to: 0.1, looping: true, want: true },
    { exitTime: 0, from: 0.1, to: 0.2, looping: true, want: false },
    { exitTime: 0.5, from: 1, to: 1, looping: false, want: true },
  ])("exit time $exitTime from $from to $to (looping $looping) is $want", ({ exitTime, from, to, looping, want }) => {
    const facts = {
      elapsedSeconds: 0,
      durationSeconds: 1,
      normalisedTime: looping ? to % 1 : to,
      remainingSeconds: 0,
      remainingRatio: 0,
      looping,
      loopCount: looping ? Math.floor(to) : 0,
      justLooped: false,
      justFinished: false,
      totalNormalisedTime: to,
      previousTotalNormalisedTime: from,
    };
    expect(animExitTimeReached(facts, exitTime)).toBe(want);
  });
});

describe("anim graph evaluator: pose graphs", () => {
  const withStateGraph = (graph: SerializedGraph): AnimGraphDocument =>
    machineDoc([{ id: "move", name: "Move", position: { x: 0, y: 0 }, stateGraph: graph }]);

  it("blends two players by Alpha, stored on the node or computed by the graph's data module", () => {
    const doc = withStateGraph(poseGraph("3d", [node("blend", "anim.pose.blend", { "default:alpha": 0.25 }), player("walk"), player("run")], [
      wire("walk", "blend", "a"),
      wire("run", "blend", "b"),
    ]));
    expect(weightsByGuid(evaluateAnimGraph(doc, null, 0.1, {}))).toEqual({ walk: 0.75, run: 0.25 });
    const graphKeys: string[] = [];
    const computed = evaluateAnimGraph(doc, null, 0.1, {
      poseData: (key) => {
        graphKeys.push(key);
        return key === "locomotion/move" ? { blend: { alpha: 0.6 } } : undefined;
      },
    });
    expect(weightsByGuid(computed)).toEqual({ walk: 0.4, run: 0.6 });
    expect(graphKeys).toEqual(["anim", "locomotion/move"]);
  });

  it("eases Blend Poses By Bool to the other input over that input's blend time", () => {
    const doc = withStateGraph(poseGraph("3d", [node("pick", "anim.pose.blendByBool", { falseBlendSeconds: 0.4 }), player("armed"), player("relaxed")], [
      wire("armed", "pick", "truePose"),
      wire("relaxed", "pick", "falsePose"),
    ]));
    const armed = evaluateAnimGraph(doc, null, 0.1, {});
    expect(weightsByGuid(armed)).toEqual({ armed: 1 });
    const off: AnimGraphInputs = { poseData: () => ({ pick: { active: false } }) };
    const easing = evaluateAnimGraph(doc, armed, 0.2, off);
    expect(weightsByGuid(easing)).toEqual({ armed: 0.5, relaxed: 0.5 });
    expect(weightsByGuid(evaluateAnimGraph(doc, easing, 0.2, off))).toEqual({ relaxed: 1 });
  });

  it("plays the input Blend Poses By Int picks: a Sequence Evaluator holds its time and Rest Pose adds no clip", () => {
    const doc = withStateGraph(poseGraph("3d", [
      node("pick", "anim.pose.blendByInt", { count: 3, blendSeconds: 0, "default:activeIndex": 1 }),
      player("a"),
      node("held", "anim.pose.sequenceEvaluator", { assetGuid: "door", clipName: "open", "default:normalizedTime": 0.75 }),
      node("rest", "anim.pose.restPose"),
    ], [wire("a", "pick", "pose0"), wire("held", "pick", "pose1"), wire("rest", "pick", "pose2")]));
    expect(evaluateAnimGraph(doc, null, 0.1, {}).layers).toEqual([
      expect.objectContaining({ clipAssetGuid: "door", clipName: "open", normalisedTime: 0.75, weight: 1 }),
    ]);
    expect(evaluateAnimGraph(doc, null, 0.1, { poseData: () => ({ pick: { activeIndex: 2 } }) }).layers).toEqual([]);
  });

  it("follows a state's primary player for its facts and starts it at its Start Position", () => {
    const graph = poseGraph("3d", [node("blend", "anim.pose.blend"), player("walk", { durationMs: 2000, "default:startPosition": 0.5 }), player("run")], [
      wire("walk", "blend", "a"),
      wire("run", "blend", "b"),
    ]);
    expect(primaryPosePlayer(graph)?.id).toBe("walk");
    expect(singlePlayerOf(graph)).toBeNull();
    const current = evaluateAnimGraph(withStateGraph(graph), null, 0.5, {});
    expect(current.facts.durationSeconds).toBe(2);
    expect(current.normalisedTime).toBeCloseTo(0.75);
    expect(current.players["locomotion/move#walk"]?.normalised).toBeCloseTo(0.75);
    expect(current.players["locomotion/move#run"]?.normalised).toBeCloseTo(0.5);
  });

  it("plays each State Machine node in the Anim Graph, scaled by the nodes above it", () => {
    const doc = machineDoc([state("idle")]);
    doc.stateMachines.push({ id: "upper", name: "Upper", entryStateId: "wave", states: [state("wave")], transitions: [] });
    doc.animGraph = poseGraph("3d", [
      node("mix", "anim.pose.blend", { "default:alpha": 0.5 }),
      node("lower", "anim.pose.stateMachine", { machineId: "locomotion" }),
      node("top", "anim.pose.stateMachine", { machineId: "upper" }),
    ], [wire("lower", "mix", "a"), wire("top", "mix", "b")]);
    const current = evaluateAnimGraph(doc, null, 0.1, {});
    expect(weightsByGuid(current)).toEqual({ "idle-clip": 0.5, "wave-clip": 0.5 });
    expect(Object.keys(current.machines).sort()).toEqual(["locomotion", "upper"]);
    expect(current.machines.upper?.stateId).toBe("wave");
    // The primary State Machine is the first the Anim Graph names.
    expect(current.stateId).toBe("idle");
  });

  it("shows one 2D frame through Select Frame By Bool and mirrors it with Flip Frame", () => {
    const doc = machineDoc([{
      id: "jump",
      name: "Jump",
      position: { x: 0, y: 0 },
      stateGraph: poseGraph("2d", [
        node("flip", "anim.frame.flip", { "default:flipX": true }),
        node("pick", "anim.frame.selectByBool", { "default:active": false }),
        node("up", "anim.frame.spritePlayer", { assetGuid: "up", durationMs: 400, frameCount: 4, "default:startFrame": 2 }),
        node("down", "anim.frame.spritePlayer", { assetGuid: "down", durationMs: 400 }),
      ], [wire("pick", "flip", "frame"), wire("up", "pick", "trueFrame"), wire("down", "pick", "falseFrame")]),
    }]);
    doc.animGraph = createAnimGraphGraph("2d", "locomotion");
    const current = evaluateAnimGraph(doc, null, 0.1, {});
    expect(current.layers).toEqual([expect.objectContaining({ clipAssetGuid: "down", clipKind: "sprite", flipX: true, weight: 1 })]);
    // The hidden input keeps its own time, from its Start Frame.
    expect(current.players["locomotion/jump#up"]?.normalised).toBeCloseTo(0.75);
  });
});

describe("anim graph document", () => {
  it("creates an Anim Graph that plays Locomotion, whose Idle state plays one player", () => {
    const doc = createDefaultAnimGraph("Hero", { skeletonGuid: "rig" });
    expect(doc.skeletonGuid).toBe("rig");
    expect(doc.animationObject.nodes.map((row) => row.type)).toEqual([ANIM_EVENT_INITIALIZE_TYPE, ANIM_EVENT_UPDATE_TYPE]);
    expect(doc.animGraph.nodes.map((row) => row.type).sort()).toEqual(["anim.pose.output", "anim.pose.stateMachine"]);
    expect(primaryStateMachine(doc)?.states.map((row) => row.name)).toEqual(["Idle"]);
    expect(singlePlayerOf(doc.stateMachines[0]!.states[0]!.stateGraph)?.type).toBe("anim.pose.sequencePlayer");
    expect(validateAnimGraph(doc)).toEqual([]);
    const twoD = createDefaultAnimGraph("Robot", { dimension: "2d", skeletonGuid: "rig" });
    expect(twoD.skeletonGuid).toBeNull();
    expect(twoD.animGraph.nodes.map((row) => row.type).sort()).toEqual(["anim.frame.output", "anim.frame.stateMachine"]);
    expect(singlePlayerOf(twoD.stateMachines[0]!.states[0]!.stateGraph)?.type).toBe("anim.frame.spritePlayer");
  });

  it("round-trips through parsing, keeping graphs and the trimmed Skeleton", () => {
    const doc = createDefaultAnimGraph("Hero", { skeletonGuid: "rig" });
    const parsed = parseAnimGraphDocument(JSON.parse(JSON.stringify({ ...doc, skeletonGuid: " rig " })))!;
    expect(parsed).toEqual(doc);
    expect(animPoseGraphs(parsed).map((entry) => entry.key)).toEqual(["anim", "locomotion/idle"]);
    expect(parseAnimGraphDocument({ name: "Old", states: [], transitions: [] })).toBeNull();
  });

  it("gives back an Anim Graph output and a state graph a document lost", () => {
    const doc = createDefaultAnimGraph();
    const raw = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    raw.animGraph = { nodes: [], edges: [] };
    (raw.stateMachines as Array<{ states: Array<Record<string, unknown>> }>)[0]!.states[0]!.stateGraph = undefined;
    const parsed = parseAnimGraphDocument(raw)!;
    expect(parsed.animGraph.nodes.map((row) => row.type)).toEqual(["anim.pose.output"]);
    expect(singlePlayerOf(parsed.stateMachines[0]!.states[0]!.stateGraph)).not.toBeNull();
  });

  it("keeps Tag variable types and normalizes serialized TagContainer defaults", () => {
    const parsed = parseAnimGraphDocument({
      ...createDefaultAnimGraph(),
      variables: [
        { id: "current", name: "Current", typeId: "tag", defaultValue: 300 },
        { id: "tags", name: "Tags", typeId: "struct", typeClassId: "engine:TagContainer", defaultValue: { Tags: [300, 300, 0, -1, "300", 301] } },
        { id: "empty", name: "Empty", typeId: "tag", defaultValue: "300" },
      ],
    });
    expect(parsed?.variables).toEqual([
      { id: "current", name: "Current", typeId: "tag", defaultValue: 300 },
      { id: "tags", name: "Tags", typeId: "struct", typeClassId: "engine:TagContainer", defaultValue: { Tags: [300, 301] } },
      { id: "empty", name: "Empty", typeId: "tag", defaultValue: 0 },
    ]);
    expect(animGraphMembersFromVariables(parsed!.variables)[1]).toMatchObject({
      typeId: "struct", typeClassId: "engine:TagContainer", defaultValue: { Tags: [300, 301] },
    });
  });

  it("exposes variables as Class-style members for Get Variable", () => {
    expect(animGraphMembersFromVariables([{ id: "v", name: "Speed", typeId: "float", defaultValue: 0 }])).toEqual([
      { id: "v", kind: "variable", name: "Speed", typeId: "float", defaultValue: 0 },
    ]);
  });

  it("seeds protected Enter State and Exit State nodes in a new rule, and disables Exit State on the canvas of a one-way rule", () => {
    const graph = createDefaultTransitionRuleGraph();
    expect(graph.nodes.map((row) => [row.type, row.data.__protected])).toEqual([[ANIM_RULE_ENTER_TYPE, true], [ANIM_RULE_EXIT_TYPE, true]]);
    const oneWay = decorateTransitionRuleGraph(graph, true);
    expect(oneWay.nodes.find((row) => row.type === ANIM_RULE_EXIT_TYPE)?.data.__disabled).toBe(true);
    expect(persistTransitionRuleGraph(oneWay).nodes.find((row) => row.type === ANIM_RULE_EXIT_TYPE)?.data.__disabled).toBeUndefined();
  });
});

describe("validateAnimGraph", () => {
  const codes = (doc: AnimGraphDocument, catalog: AnimClipCatalogEntry[] = [], dimension?: AnimGraphDimension) =>
    validateAnimGraph(doc, catalog, { dimension }).map((row) => [row.code, row.nodeId ?? null, row.location?.kind ?? null]);

  it("reports State Machine problems in their State Machine", () => {
    const doc = machineDoc(
      [state("idle"), { ...state("run"), name: " idle " }],
      [transition("a", "idle", "run"), transition("b", "idle", "run"), transition("c", "idle", "ghost")],
      "gone",
    );
    doc.stateMachines[0]!.transitions[0]!.ruleGraph = { nodes: [], edges: [] };
    expect(codes(doc)).toEqual([
      ["anim.missingEntry", "gone", "machine"],
      ["anim.duplicateStateName", "run", "machine"],
      ["anim.missingRuleNode", "a", "machine"],
      ["anim.duplicateTransition", "idle", "machine"],
      ["anim.badTransition", "c", "machine"],
    ]);
  });

  it("checks State Machine nodes, State Machine names, transition ids across machines and each pose graph's output", () => {
    const doc = machineDoc([state("idle")], [transition("t", "idle", "idle")]);
    doc.stateMachines.push({ id: "spare", name: "Locomotion", entryStateId: "idle", states: [state("idle")], transitions: [transition("t", "idle", "idle")] });
    doc.animGraph = poseGraph("3d", [
      node("m", "anim.pose.stateMachine", { machineId: "locomotion" }),
      node("again", "anim.pose.stateMachine", { machineId: "locomotion" }),
      node("lost", "anim.pose.stateMachine", { machineId: "nope" }),
    ]);
    doc.stateMachines[0]!.states[0]!.stateGraph = { nodes: [player("p")], edges: [] };
    expect(codes(doc)).toEqual([
      ["anim.machineReused", "again", "anim"],
      ["anim.missingMachine", "lost", "anim"],
      ["anim.unusedMachine", null, "anim"],
      ["anim.duplicateMachineName", null, "anim"],
      ["anim.duplicateTransitionId", "idle", "machine"],
      ["anim.missingOutput", "idle", "machine"],
    ]);
  });

  it("allows a 3D graph only Animations on its Skeleton, and checks each Animation against its Model", () => {
    const catalog: AnimClipCatalogEntry[] = [
      { guid: "knight-run", type: "Animation", name: "Knight_Run", clipName: "Run", skeletonGuid: "knight-rig", modelGuid: "knight" },
      { guid: "door-open", type: "Animation", name: "Door_Open", clipName: "open", skeletonGuid: null },
      { guid: "robot-walk", type: "SpriteAnimation", name: "Robot_Walk", durationMs: 400 },
      { guid: "knight", type: "Model", name: "Knight", skeletonGuid: "other-rig" },
    ];
    const playing = (dimension: AnimGraphDimension, assetGuid: string, skeletonGuid: string | null): AnimGraphDocument => ({
      ...machineDoc([{ ...state("idle"), stateGraph: createStateGraph(dimension, { assetGuid }) }]),
      skeletonGuid,
    });
    expect(codes(playing("3d", "knight-run", "knight-rig"), catalog, "3d")).toEqual([["anim.skeletonMismatch", "player", "state"]]);
    expect(codes(playing("3d", "door-open", "knight-rig"), catalog, "3d")).toEqual([["anim.clipSkeleton", "player", "state"]]);
    expect(codes(playing("3d", "door-open", null), catalog, "3d")).toEqual([]);
    expect(codes(playing("3d", "robot-walk", null), catalog, "3d")).toEqual([["anim.clipKind", "player", "state"]]);
    expect(codes(playing("2d", "knight-run", null), catalog, "2d")).toEqual([["anim.clipKind", "player", "state"]]);
    expect(codes(playing("2d", "robot-walk", null), catalog, "2d")).toEqual([]);
  });

  it("rejects duplicate variable names", () => {
    const doc: AnimGraphDocument = {
      ...createDefaultAnimGraph(),
      variables: [{ id: "a", name: "Speed", typeId: "float" }, { id: "b", name: "speed", typeId: "float" }],
    };
    expect(codes(doc)).toEqual([["anim.duplicateVariable", "b", null]]);
  });
});

describe("State Machine canvas", () => {
  const twoStates = (): AnimStateMachine => ({
    id: "locomotion",
    name: "Locomotion",
    entryStateId: "idle",
    states: [state("idle"), { ...state("run"), position: { x: 300, y: 80 } }],
    transitions: [transition("idle-to-run", "idle", "run", { blendSeconds: 0.25 })],
  });

  it("round-trips positions, the entry state and transition fields, keeping each state's graph", () => {
    const machine = twoStates();
    const serialized = hydrateAnimGraphForEditor(stateMachineToSerialized(machine));
    expect(serialized.nodes.map((row) => [row.type, row.data.title, row.data.entry])).toEqual([["anim.state", "Idle", true], ["anim.state", "Run", false]]);
    expect(serialized.nodes[0]!.data.__pins).toBeTruthy();
    serialized.nodes[1]!.position = { x: 420, y: 160 };
    serialized.edges[0] = { ...serialized.edges[0]!, id: "canvas-edge-1" };
    const next = serializedToStateMachine(serialized, machine, "3d");
    expect(next.states[1]).toMatchObject({ position: { x: 420, y: 160 }, stateGraph: machine.states[1]!.stateGraph });
    expect(next.entryStateId).toBe("idle");
    // A wire drawn again between the same two states keeps its transition's id.
    expect(next.transitions).toEqual([expect.objectContaining({ id: "idle-to-run", fromStateId: "idle", toStateId: "run", blendSeconds: 0.25 })]);
  });

  it("gives an added state a fresh name and one player of the graph's dimension", () => {
    const machine = twoStates();
    const serialized = stateMachineToSerialized(machine);
    serialized.nodes.push(node("new", "anim.state", { title: "Idle" }));
    const next = serializedToStateMachine(serialized, machine, "2d");
    expect(next.states[2]!.name).toBe("Idle 2");
    expect(singlePlayerOf(next.states[2]!.stateGraph)?.type).toBe("anim.frame.spritePlayer");
  });

  it("draws a Both Ways pair as one edge, keeps both rows on round-trip, and names the edge either direction lights", () => {
    const doc = machineDoc(twoStates().states, twoStates().transitions);
    const both = setTransitionBidirectional(doc, "idle-to-run", true);
    const machine = both.stateMachines[0]!;
    expect(machine.transitions).toHaveLength(2);
    const serialized = stateMachineToSerialized(machine);
    expect(serialized.edges).toEqual([expect.objectContaining({ id: "idle-to-run", type: "animTransitionBoth" })]);
    expect(serializedToStateMachine(serialized, machine, "3d").transitions).toHaveLength(2);
    expect(animTransitionEdgeId(machine.transitions, "run", "idle")).toBe("idle-to-run");
    expect(setTransitionBidirectional(both, "idle-to-run", false).stateMachines[0]!.transitions).toHaveLength(1);
  });

  it("draws a reverse on other sides as its own wire, and only a mirrored reverse on the pair's one wire", () => {
    const forward = transition("idle-to-run", "idle", "run", { sourceHandle: "right-out", targetHandle: "left-in" });
    const own = { ...twoStates(), transitions: [forward, transition("run-to-idle", "run", "idle", { sourceHandle: "top-out", targetHandle: "top-in" })] };
    expect(stateMachineToSerialized(own).edges.map((edge) => [edge.id, edge.type])).toEqual([
      ["idle-to-run", "animTransition"],
      ["run-to-idle", "animTransition"],
    ]);
    expect(animTransitionEdgeId(own.transitions, "run", "idle")).toBe("run-to-idle");
    const mirrored = { ...twoStates(), transitions: [forward, transition("run-to-idle", "run", "idle", { sourceHandle: "left-out", targetHandle: "right-in" })] };
    expect(stateMachineToSerialized(mirrored).edges.map((edge) => [edge.id, edge.type])).toEqual([["idle-to-run", "animTransitionBoth"]]);
    expect(animTransitionEdgeId(mirrored.transitions, "run", "idle")).toBe("idle-to-run");
  });

  it("gives a mirrored pair's hidden reverse its own wire when it is drawn on other sides, without a duplicate", () => {
    const forward = transition("idle-to-run", "idle", "run", { sourceHandle: "right-out", targetHandle: "left-in" });
    const reverse = transition("run-to-idle", "run", "idle", { sourceHandle: "left-out", targetHandle: "right-in", priority: 2 });
    const machine = { ...twoStates(), transitions: [forward, reverse] };
    const canvas = stateMachineToSerialized(machine);
    canvas.edges.push({ id: "canvas-new", source: "run", target: "idle", sourceHandle: "top-out", targetHandle: "top-in" });
    const next = serializedToStateMachine(canvas, machine, "3d");
    expect(next.transitions).toEqual([
      expect.objectContaining({ id: "idle-to-run", sourceHandle: "right-out", targetHandle: "left-in" }),
      expect.objectContaining({ id: "run-to-idle", sourceHandle: "top-out", targetHandle: "top-in", priority: 2 }),
    ]);
    // Moving the shared wire keeps the hidden reverse on its old sides, now a wire of its own.
    const moved = stateMachineToSerialized(machine);
    moved.edges = [{ id: "canvas-moved", source: "idle", target: "run", sourceHandle: "bottom-out", targetHandle: "bottom-in" }];
    expect(serializedToStateMachine(moved, machine, "3d").transitions).toEqual([
      expect.objectContaining({ id: "idle-to-run", sourceHandle: "bottom-out", targetHandle: "bottom-in" }),
      expect.objectContaining({ id: "run-to-idle", sourceHandle: "left-out", targetHandle: "right-in" }),
    ]);
    // Deleting a reverse that had its own wire deletes it.
    const separate = { ...twoStates(), transitions: [forward, { ...reverse, sourceHandle: "top-out", targetHandle: "top-in" }] };
    const deleted = stateMachineToSerialized(separate);
    deleted.edges = deleted.edges.filter((edge) => edge.id !== "run-to-idle");
    expect(serializedToStateMachine(deleted, separate, "3d").transitions.map((row) => row.id)).toEqual(["idle-to-run"]);
  });

  it("loads a transition stored without sides on the sides its states face each other, so a pair mirrors", () => {
    const states = [state("idle"), { ...state("run"), position: { x: 300, y: 80 } }, { ...state("jump"), position: { x: 0, y: 400 } }];
    const stored = JSON.parse(JSON.stringify(machineDoc(states, [
      transition("idle-to-run", "idle", "run"),
      transition("run-to-idle", "run", "idle"),
      transition("idle-to-jump", "idle", "jump"),
    ])));
    const machine = parseAnimGraphDocument(stored)!.stateMachines[0]!;
    expect(machine.transitions.map((row) => [row.id, row.sourceHandle, row.targetHandle])).toEqual([
      ["idle-to-run", "right-out", "left-in"],
      ["run-to-idle", "left-out", "right-in"],
      ["idle-to-jump", "bottom-out", "top-in"],
    ]);
    expect(stateMachineToSerialized(machine).edges.map((edge) => [edge.id, edge.type])).toEqual([
      ["idle-to-run", "animTransitionBoth"],
      ["idle-to-jump", "animTransition"],
    ]);
  });

  it("builds a dragged transition from the dragged state's side to the side it is released on", () => {
    const fromRect = { x: 0, y: 0, width: 200, height: 90 };
    const toRect = { x: 400, y: 0, width: 200, height: 90 };
    const drag = { fromNodeId: "idle", toNodeId: "run", fromRect, toRect };
    // Dragged from the incoming plate, it still leaves the dragged state, on that side.
    expect(animTransitionFromDrag({ ...drag, fromHandleId: "left-in", toHandleId: null, point: { x: 500, y: 45 } })).toEqual({
      source: "idle", target: "run", sourceHandle: "left-out", targetHandle: "left-in",
    });
    // Near the middle of the body: the side facing the dragged state.
    expect(animTransitionFromDrag({ ...drag, fromHandleId: "bottom-out", toHandleId: null, point: { x: 520, y: 50 } })?.targetHandle).toBe("left-in");
    // Near an edge of the body: that side.
    expect(animTransitionFromDrag({ ...drag, fromHandleId: "right-out", toHandleId: null, point: { x: 500, y: 4 } })?.targetHandle).toBe("top-in");
    expect(animTransitionFromDrag({ ...drag, fromHandleId: "right-out", toHandleId: null, point: { x: 596, y: 45 } })?.targetHandle).toBe("right-in");
    // On a handle: that handle's side, whichever plate.
    expect(animTransitionFromDrag({ ...drag, fromHandleId: "right-out", toHandleId: "bottom-out", point: null })?.targetHandle).toBe("bottom-in");
    expect(animTransitionFromDrag({ ...drag, fromHandleId: "right-out", toHandleId: null, point: null, toNodeId: "idle" })).toBeNull();
  });

  it("flips a one-way transition with its handles, and leaves a Both Ways pair alone", () => {
    const doc = machineDoc(twoStates().states, [transition("idle-to-run", "idle", "run", { sourceHandle: "right-out", targetHandle: "left-in" })]);
    expect(flipTransitionDirection(doc, "idle-to-run").stateMachines[0]!.transitions[0]).toMatchObject({
      fromStateId: "run",
      toStateId: "idle",
      sourceHandle: "left-out",
      targetHandle: "right-in",
    });
    const both = setTransitionBidirectional(doc, "idle-to-run", true);
    expect(flipTransitionDirection(both, "idle-to-run")).toBe(both);
  });

  it("edits a transition in whichever State Machine holds it", () => {
    const doc = machineDoc([state("idle")]);
    doc.stateMachines.push({ ...twoStates(), id: "upper", name: "Upper" });
    const next = patchTransition(doc, "idle-to-run", { priority: 3 });
    expect(next.stateMachines[0]).toBe(doc.stateMachines[0]);
    expect(next.stateMachines[1]!.transitions[0]!.priority).toBe(3);
  });
});

describe("resolveAnimGraphClips", () => {
  it("fills each player's clip name and length and a Sprite Animation's frame count, keeping guids", () => {
    const doc = machineDoc([
      { ...state("idle"), stateGraph: createStateGraph("3d", { assetGuid: "walk" }) },
      { ...state("model"), stateGraph: createStateGraph("3d", { assetGuid: "hero-model" }) },
    ]);
    doc.animGraph = poseGraph("3d", [node("frames", "anim.frame.spritePlayer", { assetGuid: "robot" })]);
    const resolved = resolveAnimGraphClips(doc, [
      { guid: "walk", type: "Animation", name: "Hero_Walk", clipName: "Walk", durationMs: 800 },
      { guid: "hero-model", type: "Model", name: "Hero" },
      { guid: "robot", type: "SpriteAnimation", name: "Robot", durationMs: 400, frameCount: 4 },
    ]);
    expect(singlePlayerOf(resolved.stateMachines[0]!.states[0]!.stateGraph)?.data).toMatchObject({ assetGuid: "walk", clipName: "Walk", durationMs: 800 });
    // A guid naming a Model is not an Animation: it stays unresolved and plays nothing.
    expect(singlePlayerOf(resolved.stateMachines[0]!.states[1]!.stateGraph)?.data.clipName).toBeUndefined();
    expect(resolved.animGraph.nodes[0]!.data).toMatchObject({ assetGuid: "robot", clipName: "", durationMs: 400, frameCount: 4 });
    expect(resolveAnimGraphClips(doc, [])).toBe(doc);
  });
});

import { describe, expect, it } from "vitest";
import {
  ANIM_EVENT_INITIALIZE_TYPE,
  ANIM_EVENT_UPDATE_TYPE,
  ANIM_GRAPH_SCHEMA_VERSION,
  ANIM_RULE_ENTER_TYPE,
  ANIM_RULE_EXIT_TYPE,
  clipForState,
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  evaluateAnimGraph,
  parseAnimGraphDocument,
  validateAnimGraph,
  animGraphToSerialized,
  serializedToAnimGraph,
  hydrateAnimGraphForEditor,
  animGraphMembersFromVariables,
} from "./index";

describe("anim graph evaluator", () => {
  it("stays on the looping entry clip and wraps time", () => {
    const doc = createDefaultAnimGraph();
    const a = evaluateAnimGraph(doc, null, 0.5, { conditions: {} });
    expect(a.stateId).toBe("idle");
    expect(a.normalisedTime).toBeCloseTo(0.5, 5);
    const b = evaluateAnimGraph(doc, a, 0.75, { conditions: {} });
    expect(b.normalisedTime).toBeCloseTo(0.25, 5);
    expect(b.blendWeights.idle).toBe(1);
  });

  it("transitions when a condition is true", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: "run-clip",
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.clips.push({
      id: "run-clip",
      kind: "sprite",
      assetGuid: "sprite-1",
      clipName: "Run",
      durationMs: 400,
    });
    doc.parameters = ["moving"];
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.1,
      hasExitTime: false,
      exitTime: 0,
      priority: 0,
      ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const next = evaluateAnimGraph(doc, null, 0.016, {
      conditions: { moving: true },
    });
    expect(next.stateId).toBe("run");
    expect(next.normalisedTime).toBe(0);
  });

  it("rejects a missing entry state", () => {
    const doc = createDefaultAnimGraph();
    doc.entryStateId = "missing";
    expect(validateAnimGraph(doc).some((row) => row.code === "anim.missingEntry")).toBe(
      true,
    );
  });

  it("round-trips through the graph-ui serialized shape", () => {
    const doc = createDefaultAnimGraph();
    const next = serializedToAnimGraph(animGraphToSerialized(doc), doc);
    expect(next.entryStateId).toBe(doc.entryStateId);
    expect(next.states).toHaveLength(1);
  });

  it("rejects a missing clip and a dangling transition", () => {
    const doc = createDefaultAnimGraph();
    doc.states[0]!.clipId = "missing-clip";
    doc.transitions.push({
      id: "bad",
      fromStateId: "idle",
      toStateId: "gone",
      blendSeconds: 0,
      hasExitTime: false,
      exitTime: 0,
      priority: 0,
      ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const codes = validateAnimGraph(doc).map((row) => row.code);
    expect(codes).toContain("anim.missingClip");
    expect(codes).toContain("anim.badTransition");
  });

  it("clamps a non-looping clip at the end", () => {
    const doc = createDefaultAnimGraph();
    doc.states[0]!.loop = false;
    const next = evaluateAnimGraph(doc, null, 2, { conditions: {} });
    expect(next.normalisedTime).toBe(1);
  });

  it("round-trips a document-chunk payload and resolves the state clip", () => {
    const doc = createDefaultAnimGraph("Hero");
    const parsed = parseAnimGraphDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
    expect(parseAnimGraphDocument({ name: "bad" })).toBeNull();
    expect(clipForState(doc, "idle")?.clipName).toBe("Idle");
  });

  it("hydrates state pins so Add Node is not an empty box", () => {
    const hydrated = hydrateAnimGraphForEditor(
      animGraphToSerialized(createDefaultAnimGraph()),
    );
    const pins = hydrated.nodes[0]?.data.__pins as Array<{
      id: string;
      direction: string;
    }>;
    expect(pins.some((pin) => pin.id === "in" && pin.direction === "in")).toBe(
      true,
    );
    expect(pins.some((pin) => pin.id === "out" && pin.direction === "out")).toBe(
      true,
    );
  });

  it("round-trips dragged node positions through the graph-ui serialized shape", () => {
    const doc = createDefaultAnimGraph();
    const serialized = animGraphToSerialized(doc);
    serialized.nodes[0]!.position = { x: 420, y: 160 };
    const next = serializedToAnimGraph(serialized, doc);
    expect(next.states[0]!.position).toEqual({ x: 420, y: 160 });
    expect(animGraphToSerialized(next).nodes[0]!.position).toEqual({
      x: 420,
      y: 160,
    });
  });

  it("preserves transition condition and blend fields across a graph-ui round-trip", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: "run-clip",
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.clips.push({
      id: "run-clip",
      kind: "sprite",
      assetGuid: "sprite-1",
      clipName: "Run",
      durationMs: 400,
    });
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.25,
      hasExitTime: true,
      exitTime: 0.8,
      priority: 0,
      ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const next = serializedToAnimGraph(animGraphToSerialized(doc), doc);
    expect(next.transitions[0]).toMatchObject({
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.25,
      hasExitTime: true,
      exitTime: 0.8,
    });
  });

  it("keeps transition fields when the canvas edge id changes", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.25,
      hasExitTime: true,
      exitTime: 0.8,
      priority: 0,
      ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const serialized = animGraphToSerialized(doc);
    expect(serialized.edges[0]).toMatchObject({
      id: "idle-to-run",
      source: "idle",
      target: "run",
      type: "animTransition",
    });
    serialized.edges[0] = { ...serialized.edges[0]!, id: "canvas-edge-1" };
    const next = serializedToAnimGraph(serialized, doc);
    expect(next.transitions[0]).toMatchObject({
      id: "canvas-edge-1",
      fromStateId: "idle",
      toStateId: "run",
      condition: "moving",
      blendSeconds: 0.25,
      hasExitTime: true,
      exitTime: 0.8,
    });
  });

  it("assigns fallback layout when a document-chunk omits position", () => {
    const parsed = parseAnimGraphDocument({
      name: "Loco",
      entryStateId: "idle",
      states: [
        { id: "idle", name: "Idle", clipId: null, speed: 1, loop: true },
        { id: "run", name: "Run", clipId: null, speed: 1, loop: true },
      ],
      transitions: [],
      clips: [],
      parameters: [],
    });
    expect(parsed?.states[0]!.position).toEqual({ x: 80, y: 80 });
    expect(parsed?.states[1]!.position).toEqual({ x: 300, y: 80 });
  });

  it("round-trips stored positions through parse", () => {
    const parsed = parseAnimGraphDocument({
      name: "Loco",
      entryStateId: "idle",
      states: [
        {
          id: "idle",
          name: "Idle",
          clipId: null,
          speed: 1,
          loop: true,
          position: { x: 12, y: 34 },
        },
      ],
      transitions: [],
      clips: [],
      parameters: [],
    });
    expect(parsed?.states[0]!.position).toEqual({ x: 12, y: 34 });
  });
});

describe("anim graph v2 document", () => {
  it("creates a versioned document with Animation Object events and empty variables", () => {
    const doc = createDefaultAnimGraph();
    expect(doc.schemaVersion).toBe(ANIM_GRAPH_SCHEMA_VERSION);
    expect(doc.variables).toEqual([]);
    expect(doc.animationObject.nodes.map((node) => node.type)).toEqual([
      ANIM_EVENT_INITIALIZE_TYPE,
      ANIM_EVENT_UPDATE_TYPE,
    ]);
    expect(
      doc.animationObject.nodes.every(
        (node) => node.data.__protected === true,
      ),
    ).toBe(true);
  });

  it("migrates legacy parameter names into typed bool variables", () => {
    const parsed = parseAnimGraphDocument({
      name: "Loco",
      entryStateId: "idle",
      states: [{ id: "idle", name: "Idle", clipId: null, speed: 1, loop: true }],
      transitions: [],
      clips: [],
      parameters: ["moving", "attack"],
    });
    expect(parsed?.schemaVersion).toBe(ANIM_GRAPH_SCHEMA_VERSION);
    expect(parsed?.variables.map((row) => row.name)).toEqual([
      "moving",
      "attack",
    ]);
    expect(parsed?.variables.every((row) => row.typeId === "bool")).toBe(true);
    expect(parsed?.parameters).toEqual(["moving", "attack"]);
  });

  it("migrates a named condition onto Exit State and leaves Enter State disconnected", () => {
    const parsed = parseAnimGraphDocument({
      name: "Loco",
      entryStateId: "idle",
      states: [
        { id: "idle", name: "Idle", clipId: null, speed: 1, loop: true },
        { id: "run", name: "Run", clipId: null, speed: 1, loop: true },
      ],
      transitions: [
        {
          id: "idle-to-run",
          fromStateId: "idle",
          toStateId: "run",
          condition: "moving",
          blendSeconds: 0.2,
          hasExitTime: false,
          exitTime: 0,
        },
      ],
      clips: [],
      parameters: ["moving"],
    });
    const rule = parsed?.transitions[0]?.ruleGraph;
    expect(rule?.nodes.some((node) => node.type === ANIM_RULE_ENTER_TYPE)).toBe(
      true,
    );
    expect(rule?.nodes.some((node) => node.type === ANIM_RULE_EXIT_TYPE)).toBe(
      true,
    );
    const getVar = rule?.nodes.find((node) => node.type === "variables.get");
    expect(getVar?.data.variableName).toBe("moving");
    expect(
      rule?.edges.some(
        (edge) =>
          edge.source === getVar?.id &&
          edge.target ===
            rule.nodes.find((node) => node.type === ANIM_RULE_EXIT_TYPE)?.id,
      ),
    ).toBe(true);
    expect(
      rule?.edges.some(
        (edge) =>
          edge.target ===
          rule.nodes.find((node) => node.type === ANIM_RULE_ENTER_TYPE)?.id,
      ),
    ).toBe(false);
  });

  it("seeds a protected Enter State and Exit State on a new transition rule graph", () => {
    const rule = createDefaultTransitionRuleGraph();
    expect(rule.nodes).toHaveLength(2);
    expect(rule.nodes.map((node) => node.type)).toEqual([
      ANIM_RULE_ENTER_TYPE,
      ANIM_RULE_EXIT_TYPE,
    ]);
    expect(rule.nodes.every((node) => node.data.__protected === true)).toBe(
      true,
    );
  });

  it("exposes Animation Graph variables as Class-style members for Get/Set", () => {
    expect(
      animGraphMembersFromVariables([
        { id: "var-moving", name: "moving", typeId: "bool", defaultValue: false },
      ]),
    ).toEqual([
      {
        id: "var-moving",
        kind: "variable",
        name: "moving",
        typeId: "bool",
        defaultValue: false,
      },
    ]);
  });

  it("rejects duplicate variable names and missing rule sinks", () => {
    const doc = createDefaultAnimGraph();
    doc.variables = [
      { id: "a", name: "Speed", typeId: "float", defaultValue: 0 },
      { id: "b", name: "speed", typeId: "float", defaultValue: 1 },
    ];
    doc.transitions.push({
      id: "self",
      fromStateId: "idle",
      toStateId: "idle",
      blendSeconds: 0,
      priority: 0,
      ruleGraph: { nodes: [], edges: [] },
    });
    const codes = validateAnimGraph(doc).map((row) => row.code);
    expect(codes).toContain("anim.duplicateVariable");
    expect(codes).toContain("anim.missingRuleNode");
  });
});

describe("anim graph v2 evaluator", () => {
  it("keeps a transition gated until both Enter State and Exit State are true", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      blendSeconds: 0,
      priority: 0,
      ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const blocked = evaluateAnimGraph(doc, null, 0.016, {
      variables: {},
      transitionRules: { "idle-to-run": { enter: true, exit: false } },
    });
    expect(blocked.stateId).toBe("idle");
    const next = evaluateAnimGraph(doc, blocked, 0.016, {
      variables: {},
      transitionRules: { "idle-to-run": { enter: true, exit: true } },
    });
    expect(next.stateId).toBe("run");
    expect(next.normalisedTime).toBe(0);
  });

  it("emits Just Finished for one tick when a non-looping clip ends", () => {
    const doc = createDefaultAnimGraph();
    doc.states[0]!.loop = false;
    const ending = evaluateAnimGraph(doc, null, 1, { variables: {} });
    expect(ending.normalisedTime).toBe(1);
    expect(ending.facts.justFinished).toBe(true);
    expect(ending.facts.justLooped).toBe(false);
    const held = evaluateAnimGraph(doc, ending, 0.016, { variables: {} });
    expect(held.facts.justFinished).toBe(false);
    expect(held.normalisedTime).toBe(1);
  });

  it("emits Just Looped when a looping clip wraps, including multiple wraps in one tick", () => {
    const doc = createDefaultAnimGraph();
    const wrapped = evaluateAnimGraph(doc, null, 2.5, { variables: {} });
    expect(wrapped.facts.justLooped).toBe(true);
    expect(wrapped.facts.loopCount).toBe(2);
    expect(wrapped.normalisedTime).toBeCloseTo(0.5, 5);
    expect(wrapped.facts.justFinished).toBe(false);
  });

  it("crossfades into weighted clip layers using blendSeconds", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0]!.assetGuid = "anim-idle";
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: "run-clip",
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.clips.push({
      id: "run-clip",
      kind: "sprite",
      assetGuid: "sprite-1",
      clipName: "Run",
      durationMs: 400,
    });
    doc.transitions.push({
      id: "idle-to-run",
      fromStateId: "idle",
      toStateId: "run",
      blendSeconds: 0.2,
      priority: 0,
      ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const started = evaluateAnimGraph(doc, null, 0.1, {
      variables: {},
      transitionRules: { "idle-to-run": { enter: true, exit: true } },
    });
    expect(started.stateId).toBe("run");
    expect(started.layers).toHaveLength(2);
    const idleLayer = started.layers.find((layer) => layer.stateId === "idle");
    const runLayer = started.layers.find((layer) => layer.stateId === "run");
    expect(idleLayer?.weight).toBeCloseTo(0.5, 5);
    expect(runLayer?.weight).toBeCloseTo(0.5, 5);
    expect(runLayer?.clipAssetGuid).toBe("sprite-1");
    expect(started.blendWeights.idle).toBeCloseTo(0.5, 5);
    const finished = evaluateAnimGraph(doc, started, 0.1, {
      variables: {},
      transitionRules: { "idle-to-run": { enter: false, exit: false } },
    });
    expect(finished.layers).toHaveLength(1);
    expect(finished.layers[0]).toMatchObject({ stateId: "run", weight: 1 });
  });

  it("chooses the lowest priority outgoing transition when several pass", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push(
      {
        id: "run",
        name: "Run",
        clipId: null,
        speed: 1,
        loop: true,
        position: { x: 300, y: 80 },
      },
      {
        id: "jump",
        name: "Jump",
        clipId: null,
        speed: 1,
        loop: true,
        position: { x: 520, y: 80 },
      },
    );
    doc.transitions.push(
      {
        id: "to-run",
        fromStateId: "idle",
        toStateId: "run",
        blendSeconds: 0,
        priority: 10,
        ruleGraph: createDefaultTransitionRuleGraph(),
      },
      {
        id: "to-jump",
        fromStateId: "idle",
        toStateId: "jump",
        blendSeconds: 0,
        priority: 1,
        ruleGraph: createDefaultTransitionRuleGraph(),
      },
    );
    const next = evaluateAnimGraph(doc, null, 0.016, {
      variables: {},
      transitionRules: {
        "to-run": { enter: true, exit: true },
        "to-jump": { enter: true, exit: true },
      },
    });
    expect(next.stateId).toBe("jump");
  });

  it("reports remaining time until the current clip loops or ends", () => {
    const doc = createDefaultAnimGraph();
    const next = evaluateAnimGraph(doc, null, 0.25, { variables: {} });
    expect(next.facts.elapsedSeconds).toBeCloseTo(0.25, 5);
    expect(next.facts.durationSeconds).toBeCloseTo(1, 5);
    expect(next.facts.remainingSeconds).toBeCloseTo(0.75, 5);
    expect(next.facts.remainingRatio).toBeCloseTo(0.75, 5);
    expect(next.facts.looping).toBe(true);
  });

  it("asks decideTransition with post-advance facts including Just Finished", () => {
    const doc = createDefaultAnimGraph();
    doc.states[0]!.loop = false;
    doc.states.push({
      id: "done",
      name: "Done",
      clipId: null,
      speed: 1,
      loop: false,
      position: { x: 300, y: 80 },
    });
    doc.transitions.push({
      id: "idle-to-done",
      fromStateId: "idle",
      toStateId: "done",
      blendSeconds: 0,
      priority: 0,
      ruleGraph: createDefaultTransitionRuleGraph(),
    });
    const seen: Array<{ normalisedTime: number; justFinished: boolean }> = [];
    const decide = (
      _transition: (typeof doc.transitions)[number],
      facts: { normalisedTime: number; justFinished: boolean },
    ) => {
      seen.push({
        normalisedTime: facts.normalisedTime,
        justFinished: facts.justFinished,
      });
      return facts.justFinished
        ? { enter: true, exit: true }
        : { enter: false, exit: false };
    };
    const blocked = evaluateAnimGraph(doc, null, 0.5, { decideTransition: decide });
    expect(blocked.stateId).toBe("idle");
    expect(seen[0]?.normalisedTime).toBeCloseTo(0.5, 5);
    expect(seen[0]?.justFinished).toBe(false);
    const finished = evaluateAnimGraph(doc, blocked, 0.5, {
      decideTransition: decide,
    });
    expect(seen[1]?.justFinished).toBe(true);
    expect(finished.stateId).toBe("done");
  });
});

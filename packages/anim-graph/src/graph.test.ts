import { describe, expect, it } from "vitest";
import {
  ANIM_EVENT_INITIALIZE_TYPE,
  ANIM_EVENT_UPDATE_TYPE,
  ANIM_GRAPH_SCHEMA_VERSION,
  ANIM_RULE_ENTER_TYPE,
  ANIM_RULE_EXIT_TYPE,
  ANIM_STATE_LAYOUT_GAP_X,
  clipForState,
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  evaluateAnimGraph,
  parseAnimGraphDocument,
  resolveAnimGraphClips,
  validateAnimGraph,
  animGraphToSerialized,
  serializedToAnimGraph,
  hydrateAnimGraphForEditor,
  animGraphMembersFromVariables,
  setTransitionBidirectional,
  flipTransitionDirection,
  decorateTransitionRuleGraph,
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

  it("hydrates side handles so Add Node is not an empty box", () => {
    const hydrated = hydrateAnimGraphForEditor(
      animGraphToSerialized(createDefaultAnimGraph()),
    );
    const pins = hydrated.nodes[0]?.data.__pins as Array<{
      id: string;
      direction: string;
    }>;
    expect(pins.some((pin) => pin.id === "left-in" && pin.direction === "in")).toBe(
      true,
    );
    expect(
      pins.some((pin) => pin.id === "right-out" && pin.direction === "out"),
    ).toBe(true);
    expect(pins.some((pin) => pin.id === "in" || pin.id === "out")).toBe(false);
  });

  it("spaces default states wider than a 200px node body", () => {
    expect(ANIM_STATE_LAYOUT_GAP_X).toBeGreaterThanOrEqual(280);
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

  it("hides the reverse canvas edge and restores it on round-trip", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    const both = setTransitionBidirectional(
      {
        ...doc,
        transitions: [
          {
            id: "idle-to-run",
            fromStateId: "idle",
            toStateId: "run",
            blendSeconds: 0.2,
            priority: 0,
            ruleGraph: createDefaultTransitionRuleGraph(),
          },
        ],
      },
      "idle-to-run",
      true,
    );
    expect(both.transitions).toHaveLength(2);
    const serialized = animGraphToSerialized(both);
    expect(serialized.edges).toHaveLength(1);
    expect(serialized.edges[0]?.type).toBe("animTransitionBoth");
    expect(serialized.edges[0]).toMatchObject({
      sourceHandle: "right-out",
      targetHandle: "left-in",
    });
    const next = serializedToAnimGraph(serialized, both);
    expect(next.transitions).toHaveLength(2);
    expect(next.transitions.map((row) => `${row.fromStateId}->${row.toStateId}`).sort()).toEqual(
      ["idle->run", "run->idle"],
    );
  });

  it("flips a one-way transition and no-ops when a reverse row exists", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    const oneWay = {
      ...doc,
      transitions: [
        {
          id: "idle-to-run",
          fromStateId: "idle",
          toStateId: "run",
          blendSeconds: 0.2,
          priority: 1,
          sourceHandle: "right-out",
          targetHandle: "left-in",
          ruleGraph: createDefaultTransitionRuleGraph(),
        },
      ],
    };
    const flipped = flipTransitionDirection(oneWay, "idle-to-run");
    expect(flipped.transitions[0]).toMatchObject({
      id: "idle-to-run",
      fromStateId: "run",
      toStateId: "idle",
      blendSeconds: 0.2,
      priority: 1,
      sourceHandle: "left-out",
      targetHandle: "right-in",
    });
    const both = setTransitionBidirectional(oneWay, "idle-to-run", true);
    expect(flipTransitionDirection(both, "idle-to-run")).toBe(both);
  });

  it("disables Exit State on a one-way rule graph and restores it for both ways", () => {
    const graph = createDefaultTransitionRuleGraph();
    const oneWay = decorateTransitionRuleGraph(graph, true);
    expect(oneWay.nodes.find((node) => node.type === ANIM_RULE_EXIT_TYPE)?.data.__disabled).toBe(
      true,
    );
    expect(oneWay.nodes.find((node) => node.type === ANIM_RULE_ENTER_TYPE)?.data.__disabled).toBeUndefined();
    const both = decorateTransitionRuleGraph(oneWay, false);
    expect(both.nodes.find((node) => node.type === ANIM_RULE_EXIT_TYPE)?.data.__disabled).toBeUndefined();
  });

  it("does not take a both-ways reverse from idle when the forward condition is false", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    const both = setTransitionBidirectional(
      {
        ...doc,
        transitions: [
          {
            id: "idle-to-run",
            fromStateId: "idle",
            toStateId: "run",
            condition: "moving",
            blendSeconds: 0,
            priority: 0,
            ruleGraph: createDefaultTransitionRuleGraph(),
          },
        ],
      },
      "idle-to-run",
      true,
    );
    const fromIdle = evaluateAnimGraph(both, null, 0.016, {
      conditions: { moving: false },
    });
    expect(fromIdle.stateId).toBe("idle");
    const fromRun = evaluateAnimGraph(
      both,
      {
        stateId: "run",
        normalisedTime: 0.2,
        blendWeights: { run: 1 },
        timeMs: 200,
        facts: {
          elapsedSeconds: 0.2,
          durationSeconds: 1,
          normalisedTime: 0.2,
          remainingSeconds: 0.8,
          remainingRatio: 0.8,
          looping: true,
          loopCount: 0,
          justLooped: false,
          justFinished: false,
        },
        layers: [],
        blendFromStateId: null,
        blendFromTimeMs: 0,
        blendElapsedMs: 0,
        loopCount: 0,
      },
      0.016,
      { conditions: { moving: false } },
    );
    expect(fromRun.stateId).toBe("idle");
  });

  it("keeps one directed pair when the canvas has a duplicate edge with a generated id", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    const withTransition = {
      ...doc,
      transitions: [
        {
          id: "idle-to-run",
          fromStateId: "idle",
          toStateId: "run",
          blendSeconds: 0.25,
          priority: 0,
          ruleGraph: createDefaultTransitionRuleGraph(),
        },
      ],
    };
    const serialized = animGraphToSerialized(withTransition);
    serialized.edges = [
      ...serialized.edges,
      {
        id: "e:idle:right-out:run:left-in",
        source: "idle",
        target: "run",
        sourceHandle: "right-out",
        targetHandle: "left-in",
        type: "animTransition",
      },
    ];
    const next = serializedToAnimGraph(serialized, withTransition);
    const samePair = next.transitions.filter(
      (row) => row.fromStateId === "idle" && row.toStateId === "run",
    );
    expect(samePair).toHaveLength(1);
    expect(samePair[0]?.id).toBe("idle-to-run");
    expect(samePair[0]?.blendSeconds).toBe(0.25);
  });

  it("hides a duplicate same-direction pair from the canvas", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    doc.transitions = [
      {
        id: "idle-to-run",
        fromStateId: "idle",
        toStateId: "run",
        blendSeconds: 0.1,
        priority: 0,
        ruleGraph: createDefaultTransitionRuleGraph(),
      },
      {
        id: "e:idle:right-out:run:left-in",
        fromStateId: "idle",
        toStateId: "run",
        blendSeconds: 0.1,
        priority: 0,
        ruleGraph: createDefaultTransitionRuleGraph(),
      },
    ];
    expect(animGraphToSerialized(doc).edges).toHaveLength(1);
    expect(animGraphToSerialized(doc).edges[0]?.id).toBe("idle-to-run");
  });

  it("drops both directions when the visual edge is removed", () => {
    const doc = createDefaultAnimGraph();
    doc.states.push({
      id: "run",
      name: "Run",
      clipId: null,
      speed: 1,
      loop: true,
      position: { x: 300, y: 80 },
    });
    const both = setTransitionBidirectional(
      {
        ...doc,
        transitions: [
          {
            id: "idle-to-run",
            fromStateId: "idle",
            toStateId: "run",
            blendSeconds: 0.1,
            priority: 0,
            ruleGraph: createDefaultTransitionRuleGraph(),
          },
        ],
      },
      "idle-to-run",
      true,
    );
    const serialized = animGraphToSerialized(both);
    serialized.edges = [];
    expect(serializedToAnimGraph(serialized, both).transitions).toHaveLength(0);
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
    expect(parsed?.states[1]!.position).toEqual({
      x: 80 + ANIM_STATE_LAYOUT_GAP_X,
      y: 80,
    });
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

  it("flags an Animation whose skeleton does not match its Model", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "animation",
      assetGuid: "hero-walk-anim",
      clipName: "Walk",
      durationMs: 1000,
    };
    const codes = validateAnimGraph(doc, [
      {
        guid: "hero-model",
        type: "Model",
        name: "Hero",
        skeletonGuid: "hero-skel",
      },
      {
        guid: "hero-walk-anim",
        type: "Animation",
        name: "Hero_Walk",
        clipName: "Walk",
        modelGuid: "hero-model",
        skeletonGuid: "other-skel",
      },
    ]).map((row) => row.code);
    expect(codes).toContain("anim.skeletonMismatch");
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

describe("resolveAnimGraphClips", () => {
  const catalog = [
    {
      guid: "hero-model",
      type: "Model",
      name: "Hero",
      clipNames: ["Idle", "Walk"],
      dependencyGuids: ["hero-walk-anim"],
    },
    {
      guid: "hero-walk-anim",
      type: "Animation",
      name: "Hero_Walk",
      clipName: "Walk",
    },
    {
      guid: "hero-sprite",
      type: "Sprite",
      name: "HeroSprite",
    },
  ];

  it("keeps an Animation guid and fills the glTF clip name from that asset", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "animation",
      assetGuid: "hero-walk-anim",
      clipName: "Idle",
      durationMs: 1000,
    };
    const resolved = resolveAnimGraphClips(doc, catalog);
    expect(resolved.clips[0]).toMatchObject({
      assetGuid: "hero-walk-anim",
      clipName: "Walk",
    });
  });

  it("fills Animation clip duration from the catalog", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "animation",
      assetGuid: "hero-walk-anim",
      clipName: "Walk",
      durationMs: 1000,
    };
    const resolved = resolveAnimGraphClips(doc, [
      ...catalog,
      {
        guid: "hero-walk-anim",
        type: "Animation",
        name: "Hero_Walk",
        clipName: "Walk",
        durationMs: 1800,
      },
    ]);
    expect(resolved.clips[0]).toMatchObject({
      assetGuid: "hero-walk-anim",
      clipName: "Walk",
      durationMs: 1800,
    });
  });

  it("keeps a Model guid and a clip name that exists on that Model", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "animation",
      assetGuid: "hero-model",
      clipName: "Idle",
      durationMs: 1000,
    };
    const resolved = resolveAnimGraphClips(doc, catalog);
    expect(resolved.clips[0]).toMatchObject({
      assetGuid: "hero-model",
      clipName: "Idle",
    });
  });

  it("does not rewrite Sprite clips", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "sprite",
      assetGuid: "hero-sprite",
      clipName: "Idle",
      durationMs: 1000,
    };
    expect(resolveAnimGraphClips(doc, catalog).clips[0]!.assetGuid).toBe(
      "hero-sprite",
    );
  });

  it("returns the same document when the catalog is empty", () => {
    const doc = createDefaultAnimGraph();
    expect(resolveAnimGraphClips(doc, [])).toBe(doc);
  });

  it("keeps an Animation guid when no Model lists it as a dependency", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "animation",
      assetGuid: "orphan-anim",
      clipName: "Walk",
      durationMs: 1000,
    };
    const resolved = resolveAnimGraphClips(doc, [
      {
        guid: "orphan-anim",
        type: "Animation",
        name: "Orphan",
        clipName: "Walk",
      },
    ]);
    expect(resolved.clips[0]).toMatchObject({
      assetGuid: "orphan-anim",
      clipName: "Walk",
    });
  });

  it("fills an empty Model clip name from the first glTF group", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "animation",
      assetGuid: "hero-model",
      clipName: "",
      durationMs: 1000,
    };
    expect(resolveAnimGraphClips(doc, catalog).clips[0]?.clipName).toBe("Idle");
  });

  it("fills Sprite Animation clip duration from the catalog", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "sprite",
      assetGuid: "walk-anim",
      clipName: "",
      durationMs: 1000,
    };
    const resolved = resolveAnimGraphClips(doc, [
      {
        guid: "walk-anim",
        type: "SpriteAnimation",
        name: "Walk",
        durationMs: 250,
      },
    ]);
    expect(resolved.clips[0]).toMatchObject({
      assetGuid: "walk-anim",
      durationMs: 250,
    });
  });

  it("keeps a legacy Sprite clip duration unchanged", () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "sprite",
      assetGuid: "hero-sprite",
      clipName: "Idle",
      durationMs: 400,
    };
    expect(
      resolveAnimGraphClips(doc, [
        { guid: "hero-sprite", type: "Sprite", name: "HeroSprite" },
      ]).clips[0],
    ).toMatchObject({
      assetGuid: "hero-sprite",
      clipName: "Idle",
      durationMs: 400,
    });
  });
});

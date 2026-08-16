import type { GraphClassMember, SerializedGraph } from "@babylonslate/core";

export const ANIM_GRAPH_SCHEMA_VERSION = 2 as const;

export const ANIM_EVENT_INITIALIZE_TYPE = "anim.event.initialize";
export const ANIM_EVENT_UPDATE_TYPE = "anim.event.update";
export const ANIM_RULE_ENTER_TYPE = "anim.rule.enterState";
export const ANIM_RULE_EXIT_TYPE = "anim.rule.exitState";
export const ANIM_RULE_ENTER_NODE_ID = "enter-state";
export const ANIM_RULE_EXIT_NODE_ID = "exit-state";

export type AnimClipKind = "animation" | "sprite";
export type AnimVariableTypeId = "bool" | "int" | "float" | "string";

export interface AnimClipRef {
  id: string;
  kind: AnimClipKind;
  /** Animation or Sprite asset guid. */
  assetGuid: string;
  /** glTF AnimationGroup name or sprite clip name. */
  clipName: string;
  durationMs: number;
}

export interface AnimState {
  id: string;
  name: string;
  clipId: string | null;
  /** Speed multiplier; 1 is authored duration. */
  speed: number;
  loop: boolean;
  /** Canvas layout. Parse fills a fallback when a legacy document omits it. */
  position: { x: number; y: number };
}

export interface AnimGraphVariable {
  id: string;
  name: string;
  typeId: AnimVariableTypeId;
  defaultValue?: unknown;
}

export interface AnimTransition {
  id: string;
  fromStateId: string;
  toStateId: string;
  /** Crossfade in seconds. */
  blendSeconds: number;
  /** Lower numbers win when several transitions pass. */
  priority: number;
  ruleGraph: SerializedGraph;
  /** Legacy named bool/trigger; kept after migration for evaluator fallback. */
  condition?: string;
  hasExitTime?: boolean;
  exitTime?: number;
}

export interface AnimGraphDocument {
  schemaVersion: typeof ANIM_GRAPH_SCHEMA_VERSION;
  name: string;
  entryStateId: string;
  states: AnimState[];
  transitions: AnimTransition[];
  clips: AnimClipRef[];
  variables: AnimGraphVariable[];
  animationObject: SerializedGraph;
  /**
   * Legacy bool/trigger names. Parse keeps these in sync with bool variables
   * so older editor panels still list parameters.
   */
  parameters: string[];
}

export interface AnimTransitionDecision {
  enter: boolean;
  exit: boolean;
}

export interface AnimGraphInputs {
  variables?: Record<string, unknown>;
  /** @deprecated Prefer `variables`; bool conditions still map into the store. */
  conditions?: Record<string, boolean>;
  transitionRules?: Record<string, AnimTransitionDecision>;
  decideTransition?: (
    transition: AnimTransition,
    facts: AnimStateFacts,
  ) => AnimTransitionDecision | undefined;
}

export interface AnimStateFacts {
  elapsedSeconds: number;
  durationSeconds: number;
  normalisedTime: number;
  remainingSeconds: number;
  remainingRatio: number;
  looping: boolean;
  loopCount: number;
  justLooped: boolean;
  justFinished: boolean;
}

export interface AnimClipLayer {
  stateId: string;
  clipAssetGuid: string;
  clipName: string;
  clipKind: AnimClipKind;
  normalisedTime: number;
  weight: number;
}

export interface AnimEvalState {
  stateId: string;
  normalisedTime: number;
  blendWeights: Record<string, number>;
  timeMs: number;
  facts: AnimStateFacts;
  layers: AnimClipLayer[];
  blendFromStateId: string | null;
  blendFromTimeMs: number;
  blendElapsedMs: number;
  loopCount: number;
}

export interface AnimDiagnostic {
  code: string;
  message: string;
  nodeId?: string;
  severity: "error" | "warning";
}

export function animGraphScriptClassId(guid: string): string {
  return `AnimGraph:${guid}`;
}

export function animRuleScriptClassId(
  guid: string,
  transitionId: string,
): string {
  return `AnimRule:${guid}:${transitionId}`;
}

export const ANIM_STATE_LAYOUT_ORIGIN = { x: 80, y: 80 };
export const ANIM_STATE_LAYOUT_GAP_X = 220;

export function defaultAnimStatePosition(index: number): { x: number; y: number } {
  return {
    x: ANIM_STATE_LAYOUT_ORIGIN.x + index * ANIM_STATE_LAYOUT_GAP_X,
    y: ANIM_STATE_LAYOUT_ORIGIN.y,
  };
}

export function defaultAnimVariableValue(typeId: AnimVariableTypeId): unknown {
  switch (typeId) {
    case "bool":
      return false;
    case "int":
      return 0;
    case "float":
      return 0;
    case "string":
      return "";
  }
}

export function animGraphMembersFromVariables(
  variables: readonly AnimGraphVariable[],
): GraphClassMember[] {
  return variables.map((variable) => ({
    id: variable.id,
    kind: "variable",
    name: variable.name,
    typeId: variable.typeId,
    defaultValue: variable.defaultValue,
  }));
}

export function createDefaultAnimationObjectGraph(): SerializedGraph {
  return {
    nodes: [
      {
        id: "event-initialize",
        type: ANIM_EVENT_INITIALIZE_TYPE,
        position: { x: 80, y: 80 },
        data: {
          title: "Event Initialize Animation",
          __protected: true,
        },
      },
      {
        id: "event-update",
        type: ANIM_EVENT_UPDATE_TYPE,
        position: { x: 80, y: 240 },
        data: {
          title: "Event Update Animation",
          __protected: true,
        },
      },
    ],
    edges: [],
  };
}

export function createDefaultTransitionRuleGraph(): SerializedGraph {
  return {
    nodes: [
      {
        id: ANIM_RULE_ENTER_NODE_ID,
        type: ANIM_RULE_ENTER_TYPE,
        position: { x: 360, y: 40 },
        data: {
          title: "Enter State",
          __protected: true,
        },
      },
      {
        id: ANIM_RULE_EXIT_NODE_ID,
        type: ANIM_RULE_EXIT_TYPE,
        position: { x: 360, y: 180 },
        data: {
          title: "Exit State",
          __protected: true,
        },
      },
    ],
    edges: [],
  };
}

export function createDefaultAnimGraph(name = "Locomotion"): AnimGraphDocument {
  const idle: AnimState = {
    id: "idle",
    name: "Idle",
    clipId: "idle-clip",
    speed: 1,
    loop: true,
    position: defaultAnimStatePosition(0),
  };
  return {
    schemaVersion: ANIM_GRAPH_SCHEMA_VERSION,
    name,
    entryStateId: idle.id,
    states: [idle],
    transitions: [],
    clips: [
      {
        id: "idle-clip",
        kind: "animation",
        assetGuid: "",
        clipName: "Idle",
        durationMs: 1000,
      },
    ],
    variables: [],
    animationObject: createDefaultAnimationObjectGraph(),
    parameters: [],
  };
}

function uniqueNodeId(prefix: string, used: Set<string>): string {
  let index = 1;
  let id = `${prefix}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${index}`;
  }
  used.add(id);
  return id;
}

function migrateConditionToRuleGraph(
  condition: string | undefined,
  hasExitTime: boolean,
  exitTime: number,
): SerializedGraph {
  const graph = createDefaultTransitionRuleGraph();
  const used = new Set(graph.nodes.map((node) => node.id));
  const exitId = ANIM_RULE_EXIT_NODE_ID;
  let exitSourceId: string | null = null;
  let exitSourceHandle = "value";

  if (typeof condition === "string" && condition !== "") {
    const getId = uniqueNodeId("get-var", used);
    graph.nodes.push({
      id: getId,
      type: "variables.get",
      position: { x: 80, y: 180 },
      data: {
        title: `Get ${condition}`,
        variableName: condition,
        typeId: "bool",
        implicitSelf: true,
      },
    });
    exitSourceId = getId;
    exitSourceHandle = "value";
  }

  if (hasExitTime) {
    const timeId = uniqueNodeId("normalised-time", used);
    const cmpId = uniqueNodeId("exit-time", used);
    graph.nodes.push(
      {
        id: timeId,
        type: "anim.state.normalisedTime",
        position: { x: 80, y: 40 },
        data: { title: "Normalised Time" },
      },
      {
        id: cmpId,
        type: "math.greaterEqual",
        position: { x: 220, y: 40 },
        data: {
          title: "Greater or Equal",
          b: exitTime,
        },
      },
    );
    graph.edges.push({
      id: uniqueNodeId("e", used),
      source: timeId,
      target: cmpId,
      sourceHandle: "value",
      targetHandle: "a",
    });
    if (exitSourceId) {
      const andId = uniqueNodeId("and", used);
      graph.nodes.push({
        id: andId,
        type: "boolean.and",
        position: { x: 220, y: 180 },
        data: { title: "Boolean And" },
      });
      graph.edges.push(
        {
          id: uniqueNodeId("e", used),
          source: cmpId,
          target: andId,
          sourceHandle: "out",
          targetHandle: "a",
        },
        {
          id: uniqueNodeId("e", used),
          source: exitSourceId,
          target: andId,
          sourceHandle: exitSourceHandle,
          targetHandle: "b",
        },
      );
      exitSourceId = andId;
      exitSourceHandle = "out";
    } else {
      exitSourceId = cmpId;
      exitSourceHandle = "out";
    }
  }

  if (exitSourceId) {
    graph.edges.push({
      id: uniqueNodeId("e", used),
      source: exitSourceId,
      target: exitId,
      sourceHandle: exitSourceHandle,
      targetHandle: "value",
    });
  }
  return graph;
}

export function validateAnimGraph(doc: AnimGraphDocument): AnimDiagnostic[] {
  const diagnostics: AnimDiagnostic[] = [];
  const stateIds = new Set(doc.states.map((state) => state.id));
  const clipIds = new Set(doc.clips.map((clip) => clip.id));
  if (!stateIds.has(doc.entryStateId)) {
    diagnostics.push({
      code: "anim.missingEntry",
      message: `Entry state "${doc.entryStateId}" is not in the graph`,
      nodeId: doc.entryStateId,
      severity: "error",
    });
  }
  for (const state of doc.states) {
    if (state.clipId && !clipIds.has(state.clipId)) {
      diagnostics.push({
        code: "anim.missingClip",
        message: `State "${state.name}" references unknown clip "${state.clipId}"`,
        nodeId: state.id,
        severity: "error",
      });
    }
  }
  const seenVariables = new Map<string, string>();
  for (const variable of doc.variables) {
    const key = variable.name.trim().toLowerCase();
    const previous = seenVariables.get(key);
    if (previous) {
      diagnostics.push({
        code: "anim.duplicateVariable",
        message: `Variable "${variable.name}" duplicates "${previous}"`,
        nodeId: variable.id,
        severity: "error",
      });
    } else {
      seenVariables.set(key, variable.name);
    }
  }
  for (const transition of doc.transitions) {
    if (!stateIds.has(transition.fromStateId) || !stateIds.has(transition.toStateId)) {
      diagnostics.push({
        code: "anim.badTransition",
        message: `Transition "${transition.id}" points at a missing state`,
        nodeId: transition.id,
        severity: "error",
      });
    }
    const enter = transition.ruleGraph.nodes.filter(
      (node) => node.type === ANIM_RULE_ENTER_TYPE,
    );
    const exit = transition.ruleGraph.nodes.filter(
      (node) => node.type === ANIM_RULE_EXIT_TYPE,
    );
    if (enter.length === 0 || exit.length === 0) {
      diagnostics.push({
        code: "anim.missingRuleNode",
        message: `Transition "${transition.id}" needs Enter State and Exit State nodes`,
        nodeId: transition.id,
        severity: "error",
      });
    }
    if (enter.length > 1 || exit.length > 1) {
      diagnostics.push({
        code: "anim.duplicateRuleNode",
        message: `Transition "${transition.id}" has duplicate Enter State or Exit State nodes`,
        nodeId: transition.id,
        severity: "error",
      });
    }
  }
  return diagnostics;
}

function clipDurationMs(
  state: AnimState,
  clips: Map<string, AnimClipRef>,
): number {
  const clip = state.clipId ? clips.get(state.clipId) : undefined;
  return Math.max(1, (clip?.durationMs ?? 1000) / Math.max(0.001, state.speed));
}

function advanceClock(
  previousTimeMs: number,
  previousLoopCount: number,
  previousNormalised: number,
  dtSeconds: number,
  durationMs: number,
  loop: boolean,
): {
  timeMs: number;
  normalised: number;
  loopCount: number;
  justLooped: boolean;
  justFinished: boolean;
} {
  const dtMs = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) * 1000 : 0;
  let timeMs = previousTimeMs + dtMs;
  if (loop) {
    let loopsGained = 0;
    while (timeMs >= durationMs) {
      timeMs -= durationMs;
      loopsGained += 1;
      if (loopsGained > 100_000) {
        timeMs = timeMs % durationMs;
        break;
      }
    }
    const normalised = timeMs / durationMs;
    return {
      timeMs,
      normalised,
      loopCount: previousLoopCount + loopsGained,
      justLooped: loopsGained > 0,
      justFinished: false,
    };
  }
  const rawNorm = timeMs / durationMs;
  const finished = rawNorm >= 1;
  const normalised = Math.min(1, rawNorm);
  return {
    timeMs: normalised * durationMs,
    normalised,
    loopCount: previousLoopCount,
    justLooped: false,
    justFinished: finished && previousNormalised < 1,
  };
}

function factsFor(
  state: AnimState,
  durationMs: number,
  clock: {
    timeMs: number;
    normalised: number;
    loopCount: number;
    justLooped: boolean;
    justFinished: boolean;
  },
): AnimStateFacts {
  const durationSeconds = durationMs / 1000;
  const remainingRatio = state.loop
    ? Math.max(0, 1 - clock.normalised)
    : Math.max(0, 1 - clock.normalised);
  return {
    elapsedSeconds: clock.timeMs / 1000,
    durationSeconds,
    normalisedTime: clock.normalised,
    remainingSeconds: remainingRatio * durationSeconds,
    remainingRatio,
    looping: state.loop,
    loopCount: clock.loopCount,
    justLooped: clock.justLooped,
    justFinished: clock.justFinished,
  };
}

function layerFor(
  doc: AnimGraphDocument,
  clips: Map<string, AnimClipRef>,
  stateId: string,
  normalisedTime: number,
  weight: number,
): AnimClipLayer {
  const clip = clipForState(doc, stateId);
  return {
    stateId,
    clipAssetGuid: clip?.assetGuid ?? "",
    clipName: clip?.clipName ?? "",
    clipKind: clip?.kind ?? "animation",
    normalisedTime,
    weight,
  };
}

function readBool(
  inputs: AnimGraphInputs,
  name: string,
): boolean {
  if (inputs.variables && name in inputs.variables) {
    return inputs.variables[name] === true;
  }
  return inputs.conditions?.[name] === true;
}

function transitionPasses(
  transition: AnimTransition,
  facts: AnimStateFacts,
  inputs: AnimGraphInputs,
): boolean {
  const decided = inputs.decideTransition?.(transition, facts);
  const rule = decided ?? inputs.transitionRules?.[transition.id];
  if (rule) return rule.enter === true && rule.exit === true;
  const conditionOk =
    !transition.condition || readBool(inputs, transition.condition);
  const exitOk =
    !transition.hasExitTime || facts.normalisedTime >= (transition.exitTime ?? 0);
  return conditionOk && exitOk;
}

export function evaluateAnimGraph(
  doc: AnimGraphDocument,
  previous: AnimEvalState | null,
  dtSeconds: number,
  inputs: AnimGraphInputs,
): AnimEvalState {
  const states = new Map(doc.states.map((state) => [state.id, state]));
  const clips = new Map(doc.clips.map((clip) => [clip.id, clip]));
  let stateId = previous?.stateId ?? doc.entryStateId;
  if (!states.has(stateId)) stateId = doc.entryStateId;
  const current = states.get(stateId)!;
  const duration = clipDurationMs(current, clips);
  const clock = advanceClock(
    previous?.timeMs ?? 0,
    previous?.loopCount ?? 0,
    previous?.normalisedTime ?? 0,
    dtSeconds,
    duration,
    current.loop,
  );

  const currentFacts = factsFor(current, duration, clock);

  const outgoing = doc.transitions
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.fromStateId === stateId)
    .sort((a, b) => {
      const priority = a.row.priority - b.row.priority;
      return priority !== 0 ? priority : a.index - b.index;
    });

  let nextId = stateId;
  let nextTimeMs = clock.timeMs;
  let nextNormalised = clock.normalised;
  let nextLoopCount = clock.loopCount;
  let justLooped = clock.justLooped;
  let justFinished = clock.justFinished;
  let blendFromStateId = previous?.blendFromStateId ?? null;
  let blendFromTimeMs = previous?.blendFromTimeMs ?? 0;
  let blendElapsedMs = previous?.blendElapsedMs ?? 0;
  let startedBlend: AnimTransition | null = null;

  for (const { row } of outgoing) {
    if (!transitionPasses(row, currentFacts, inputs)) continue;
    nextId = row.toStateId;
    nextTimeMs = 0;
    nextNormalised = 0;
    nextLoopCount = 0;
    justLooped = false;
    justFinished = false;
    startedBlend = row.blendSeconds > 0 ? row : null;
    break;
  }

  if (startedBlend) {
    blendFromStateId = stateId;
    blendFromTimeMs = clock.timeMs;
    blendElapsedMs = Math.max(0, dtSeconds) * 1000;
  } else if (blendFromStateId && nextId === stateId) {
    blendElapsedMs += Math.max(0, dtSeconds) * 1000;
  } else if (nextId !== stateId) {
    blendFromStateId = null;
    blendFromTimeMs = 0;
    blendElapsedMs = 0;
  }

  const nextState = states.get(nextId) ?? current;
  const nextDuration = clipDurationMs(nextState, clips);
  const nextFacts = factsFor(nextState, nextDuration, {
    timeMs: nextTimeMs,
    normalised: nextNormalised,
    loopCount: nextLoopCount,
    justLooped,
    justFinished,
  });

  const layers: AnimClipLayer[] = [];
  const blendWeights: Record<string, number> = {};
  const blendState = blendFromStateId ? states.get(blendFromStateId) : undefined;
  const blendSeconds = startedBlend?.blendSeconds
    ?? (blendFromStateId
      ? doc.transitions.find(
          (row) =>
            row.fromStateId === blendFromStateId && row.toStateId === nextId,
        )?.blendSeconds
      : 0)
    ?? 0;
  const blendDurationMs = Math.max(0, blendSeconds) * 1000;
  let fromWeight = 0;
  let toWeight = 1;
  if (blendState && blendFromStateId && blendDurationMs > 0 && blendFromStateId !== nextId) {
    const t = Math.min(1, blendElapsedMs / blendDurationMs);
    fromWeight = 1 - t;
    toWeight = t;
    const fromDuration = clipDurationMs(blendState, clips);
    const fromClock = advanceClock(
      blendFromTimeMs,
      0,
      blendFromTimeMs / fromDuration,
      startedBlend ? 0 : dtSeconds,
      fromDuration,
      blendState.loop,
    );
    if (t >= 1) {
      blendFromStateId = null;
      blendFromTimeMs = 0;
      blendElapsedMs = 0;
      fromWeight = 0;
      toWeight = 1;
    } else {
      blendFromTimeMs = fromClock.timeMs;
      layers.push(
        layerFor(doc, clips, blendFromStateId, fromClock.normalised, fromWeight),
      );
      blendWeights[blendFromStateId] = fromWeight;
    }
  } else if (!blendState || blendFromStateId === nextId) {
    blendFromStateId = null;
    blendFromTimeMs = 0;
    blendElapsedMs = 0;
  }

  layers.push(layerFor(doc, clips, nextId, nextNormalised, toWeight));
  blendWeights[nextId] = (blendWeights[nextId] ?? 0) + toWeight;

  return {
    stateId: nextId,
    normalisedTime: nextNormalised,
    blendWeights,
    timeMs: nextTimeMs,
    facts: nextFacts,
    layers,
    blendFromStateId,
    blendFromTimeMs,
    blendElapsedMs,
    loopCount: nextLoopCount,
  };
}

export function clipForState(
  doc: AnimGraphDocument,
  stateId: string,
): AnimClipRef | undefined {
  const state = doc.states.find((row) => row.id === stateId);
  if (!state?.clipId) return undefined;
  return doc.clips.find((clip) => clip.id === state.clipId);
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parsePosition(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const x = asFiniteNumber(row.x, Number.NaN);
  const y = asFiniteNumber(row.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function isSerializedGraph(value: unknown): value is SerializedGraph {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.nodes) && Array.isArray(row.edges);
}

function parseVariableType(value: unknown): AnimVariableTypeId {
  if (value === "int" || value === "float" || value === "string" || value === "bool") {
    return value;
  }
  return "bool";
}

function parseVariables(
  source: Record<string, unknown>,
): AnimGraphVariable[] {
  const variables: AnimGraphVariable[] = [];
  const seen = new Set<string>();
  if (Array.isArray(source.variables)) {
    for (const row of source.variables) {
      if (!row || typeof row !== "object") continue;
      const variable = row as Record<string, unknown>;
      const name =
        typeof variable.name === "string" && variable.name.trim() !== ""
          ? variable.name.trim()
          : "";
      if (name === "") continue;
      const id =
        typeof variable.id === "string" && variable.id !== ""
          ? variable.id
          : `var-${name}`;
      const typeId = parseVariableType(variable.typeId);
      variables.push({
        id,
        name,
        typeId,
        defaultValue:
          variable.defaultValue !== undefined
            ? variable.defaultValue
            : defaultAnimVariableValue(typeId),
      });
      seen.add(name.toLowerCase());
    }
  }
  const parameters = Array.isArray(source.parameters)
    ? source.parameters.filter((entry): entry is string => typeof entry === "string")
    : [];
  for (const name of parameters) {
    const trimmed = name.trim();
    if (trimmed === "" || seen.has(trimmed.toLowerCase())) continue;
    variables.push({
      id: `var-${trimmed}`,
      name: trimmed,
      typeId: "bool",
      defaultValue: false,
    });
    seen.add(trimmed.toLowerCase());
  }
  return variables;
}

function parseRuleGraph(
  value: unknown,
  condition: string | undefined,
  hasExitTime: boolean,
  exitTime: number,
): SerializedGraph {
  if (isSerializedGraph(value) && value.nodes.length > 0) {
    return {
      nodes: value.nodes.map((node) => ({ ...node, data: { ...node.data } })),
      edges: value.edges.map((edge) => ({ ...edge })),
    };
  }
  if (condition || hasExitTime) {
    return migrateConditionToRuleGraph(condition, hasExitTime, exitTime);
  }
  return createDefaultTransitionRuleGraph();
}

function parseAnimationObject(value: unknown): SerializedGraph {
  if (isSerializedGraph(value) && value.nodes.length > 0) {
    return {
      nodes: value.nodes.map((node) => ({ ...node, data: { ...node.data } })),
      edges: value.edges.map((edge) => ({ ...edge })),
      ...(Array.isArray(value.members) ? { members: value.members } : {}),
      ...(Array.isArray(value.components) ? { components: value.components } : {}),
      ...(value.functionGraphs ? { functionGraphs: value.functionGraphs } : {}),
    };
  }
  return createDefaultAnimationObjectGraph();
}

/** Recover an `AnimGraphDocument` from a document-chunk JSON payload. */
export function parseAnimGraphDocument(
  value: unknown,
): AnimGraphDocument | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.states)) return null;
  const states: AnimState[] = [];
  for (const row of source.states) {
    if (!row || typeof row !== "object") continue;
    const state = row as Record<string, unknown>;
    if (typeof state.id !== "string" || state.id === "") continue;
    states.push({
      id: state.id,
      name: typeof state.name === "string" && state.name !== "" ? state.name : state.id,
      clipId: typeof state.clipId === "string" ? state.clipId : null,
      speed: asFiniteNumber(state.speed, 1),
      loop: state.loop !== false,
      position: parsePosition(state.position) ?? defaultAnimStatePosition(states.length),
    });
  }
  if (states.length === 0) return null;
  const clips: AnimClipRef[] = [];
  if (Array.isArray(source.clips)) {
    for (const row of source.clips) {
      if (!row || typeof row !== "object") continue;
      const clip = row as Record<string, unknown>;
      if (typeof clip.id !== "string" || clip.id === "") continue;
      clips.push({
        id: clip.id,
        kind: clip.kind === "sprite" ? "sprite" : "animation",
        assetGuid: typeof clip.assetGuid === "string" ? clip.assetGuid : "",
        clipName: typeof clip.clipName === "string" ? clip.clipName : clip.id,
        durationMs: Math.max(1, asFiniteNumber(clip.durationMs, 1000)),
      });
    }
  }
  const transitions: AnimTransition[] = [];
  if (Array.isArray(source.transitions)) {
    for (const row of source.transitions) {
      if (!row || typeof row !== "object") continue;
      const transition = row as Record<string, unknown>;
      if (typeof transition.id !== "string") continue;
      if (typeof transition.fromStateId !== "string") continue;
      if (typeof transition.toStateId !== "string") continue;
      const condition =
        typeof transition.condition === "string"
          ? transition.condition
          : undefined;
      const hasExitTime = transition.hasExitTime === true;
      const exitTime = asFiniteNumber(transition.exitTime, 0);
      transitions.push({
        id: transition.id,
        fromStateId: transition.fromStateId,
        toStateId: transition.toStateId,
        blendSeconds: asFiniteNumber(transition.blendSeconds, 0.1),
        priority: asFiniteNumber(transition.priority, 0),
        ruleGraph: parseRuleGraph(
          transition.ruleGraph,
          condition,
          hasExitTime,
          exitTime,
        ),
        condition,
        hasExitTime,
        exitTime,
      });
    }
  }
  const variables = parseVariables(source);
  const entryStateId =
    typeof source.entryStateId === "string" &&
    states.some((state) => state.id === source.entryStateId)
      ? source.entryStateId
      : states[0]!.id;
  return {
    schemaVersion: ANIM_GRAPH_SCHEMA_VERSION,
    name:
      typeof source.name === "string" && source.name !== ""
        ? source.name
        : "Locomotion",
    entryStateId,
    states,
    transitions,
    clips,
    variables,
    animationObject: parseAnimationObject(source.animationObject),
    parameters: variables
      .filter((variable) => variable.typeId === "bool")
      .map((variable) => variable.name),
  };
}

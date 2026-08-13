export type AnimClipKind = "animation" | "sprite";

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
}

export interface AnimTransition {
  id: string;
  fromStateId: string;
  toStateId: string;
  /** Input condition name; empty means always after clip end. */
  condition?: string;
  /** Crossfade in seconds. */
  blendSeconds: number;
  hasExitTime: boolean;
  exitTime: number;
}

export interface AnimGraphDocument {
  name: string;
  entryStateId: string;
  states: AnimState[];
  transitions: AnimTransition[];
  clips: AnimClipRef[];
  parameters: string[];
}

export interface AnimGraphInputs {
  /** Named bool/trigger conditions. */
  conditions: Record<string, boolean>;
}

export interface AnimEvalState {
  stateId: string;
  normalisedTime: number;
  blendWeights: Record<string, number>;
  timeMs: number;
}

export interface AnimDiagnostic {
  code: string;
  message: string;
  nodeId?: string;
  severity: "error" | "warning";
}

export function createDefaultAnimGraph(name = "Locomotion"): AnimGraphDocument {
  const idle: AnimState = {
    id: "idle",
    name: "Idle",
    clipId: "idle-clip",
    speed: 1,
    loop: true,
  };
  return {
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
    parameters: [],
  };
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
  for (const transition of doc.transitions) {
    if (!stateIds.has(transition.fromStateId) || !stateIds.has(transition.toStateId)) {
      diagnostics.push({
        code: "anim.badTransition",
        message: `Transition "${transition.id}" points at a missing state`,
        nodeId: transition.id,
        severity: "error",
      });
    }
  }
  return diagnostics;
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
  let timeMs = (previous?.timeMs ?? 0) + dtSeconds * 1000;
  const state = states.get(stateId)!;
  const clip = state.clipId ? clips.get(state.clipId) : undefined;
  const duration = Math.max(1, (clip?.durationMs ?? 1000) / Math.max(0.001, state.speed));
  let normalised = timeMs / duration;

  const outgoing = doc.transitions.filter((row) => row.fromStateId === stateId);
  let next = stateId;
  for (const transition of outgoing) {
    const conditionOk =
      !transition.condition || inputs.conditions[transition.condition] === true;
    const exitOk =
      !transition.hasExitTime || normalised >= transition.exitTime;
    if (conditionOk && exitOk) {
      next = transition.toStateId;
      timeMs = 0;
      normalised = 0;
      break;
    }
  }

  if (next === stateId && state.loop && normalised >= 1) {
    const wrapped = normalised % 1;
    timeMs = wrapped * duration;
    normalised = wrapped;
  } else if (next === stateId && !state.loop) {
    normalised = Math.min(1, normalised);
    timeMs = normalised * duration;
  }

  const blendWeights: Record<string, number> = { [next]: 1 };
  return {
    stateId: next,
    normalisedTime: normalised,
    blendWeights,
    timeMs,
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
      transitions.push({
        id: transition.id,
        fromStateId: transition.fromStateId,
        toStateId: transition.toStateId,
        condition:
          typeof transition.condition === "string"
            ? transition.condition
            : undefined,
        blendSeconds: asFiniteNumber(transition.blendSeconds, 0.1),
        hasExitTime: transition.hasExitTime === true,
        exitTime: asFiniteNumber(transition.exitTime, 0),
      });
    }
  }
  const parameters = Array.isArray(source.parameters)
    ? source.parameters.filter((entry): entry is string => typeof entry === "string")
    : [];
  const entryStateId =
    typeof source.entryStateId === "string" &&
    states.some((state) => state.id === source.entryStateId)
      ? source.entryStateId
      : states[0]!.id;
  return {
    name:
      typeof source.name === "string" && source.name !== ""
        ? source.name
        : "Locomotion",
    entryStateId,
    states,
    transitions,
    clips,
    parameters,
  };
}

import type { MaterialDomain } from "./catalog";
import type { MaterialCostFeatures } from "./lower";

export type MaterialCostClass = "cheap" | "expensive";

export type MaterialPreviewStatus =
  | "clean"
  | "dirty"
  | "queued"
  | "lowering"
  | "gpuCompiling"
  | "ready"
  | "error";

export interface MaterialPreviewPolicy {
  /** Frame budget of the active session (`1000 / frameCap`). */
  frameBudgetMs: number;
  domain: MaterialDomain;
  /** Session-local compile durations for this material. Never persisted. */
  observedCompileMs?: readonly number[];
}

/**
 * Auto-preview is allowed while a compile costs at most this many frames.
 * Expressed in frames rather than milliseconds so a slower device with a
 * larger frame budget is not held to a desktop number. Two frames is the point
 * where a recompile stops reading as a hitch on the active refresh rate.
 */
const AUTO_COMPILE_FRAME_ALLOWANCE = 2;

/** Structural fallbacks used until this material has been compiled twice. */
const CHEAP_WEIGHT_LIMIT = 96;
const CHEAP_OPERATION_LIMIT = 64;
const CHEAP_SAMPLE_LIMIT = 4;

/**
 * Decide whether a graph is cheap enough to recompile automatically.
 *
 * Measured compile durations win once this session has two of them; before
 * that the structural estimate stands in. Custom GLSL and post-process passes
 * stay manual because neither has been profiled on this device.
 */
export function classifyMaterialCost(
  cost: MaterialCostFeatures,
  policy: MaterialPreviewPolicy,
): MaterialCostClass {
  if (cost.customBlocks > 0) return "expensive";
  if (policy.domain === "postProcess") return "expensive";
  const samples = policy.observedCompileMs ?? [];
  if (samples.length >= 2) {
    const worst = Math.max(...samples);
    return worst > policy.frameBudgetMs * AUTO_COMPILE_FRAME_ALLOWANCE
      ? "expensive"
      : "cheap";
  }
  if (cost.usesSceneDepth || cost.usesSceneNormal) return "expensive";
  if (cost.textureSamples > CHEAP_SAMPLE_LIMIT) return "expensive";
  if (cost.weight > CHEAP_WEIGHT_LIMIT) return "expensive";
  if (cost.operations > CHEAP_OPERATION_LIMIT) return "expensive";
  return "cheap";
}

export interface MaterialPreviewState {
  status: MaterialPreviewStatus;
  /** Newest authored generation. Every edit bumps it. */
  generation: number;
  /** Generation waiting to compile, if any. */
  queuedGeneration: number | null;
  /** Generation currently compiling, if any. */
  compilingGeneration: number | null;
  /** Newest generation whose result is on screen. */
  readyGeneration: number | null;
  costClass: MaterialCostClass;
  lastError: string | null;
  compileSamplesMs: number[];
}

export type MaterialPreviewEvent =
  | { type: "edit"; cost: MaterialCostClass }
  | { type: "idle" }
  | { type: "render" }
  | { type: "lowerStart"; generation: number }
  | { type: "compileStart"; generation: number }
  | {
      type: "result";
      generation: number;
      ok: boolean;
      durationMs?: number;
      error?: string;
    }
  | { type: "dispose" };

export function createMaterialPreviewState(): MaterialPreviewState {
  return {
    status: "clean",
    generation: 0,
    queuedGeneration: null,
    compilingGeneration: null,
    readyGeneration: null,
    costClass: "cheap",
    lastError: null,
    compileSamplesMs: [],
  };
}

const MAX_SAMPLES = 8;

/**
 * Generation-safe preview transitions.
 *
 * A compile in flight is never cancelled once the GPU has it, so a superseded
 * result is dropped at commit time instead. The newest generation always wins,
 * and the previous good result stays on screen until a newer one succeeds.
 */
export function materialPreviewReducer(
  state: MaterialPreviewState,
  event: MaterialPreviewEvent,
): MaterialPreviewState {
  switch (event.type) {
    case "edit":
      return {
        ...state,
        status: "dirty",
        generation: state.generation + 1,
        costClass: event.cost,
      };
    case "idle":
      if (state.status !== "dirty") return state;
      if (state.costClass === "expensive") return state;
      return {
        ...state,
        status: "queued",
        queuedGeneration: state.generation,
      };
    case "render": {
      if (
        state.status === "queued" ||
        state.status === "lowering" ||
        state.status === "gpuCompiling"
      ) {
        return state;
      }
      const renderGeneration =
        state.generation === state.readyGeneration
          ? state.generation + 1
          : state.generation;
      return {
        ...state,
        status: "queued",
        generation: renderGeneration,
        queuedGeneration: renderGeneration,
      };
    }
    case "lowerStart":
      if (event.generation !== state.generation) return state;
      return { ...state, status: "lowering", queuedGeneration: null };
    case "compileStart":
      if (event.generation !== state.generation) return state;
      return {
        ...state,
        status: "gpuCompiling",
        queuedGeneration: null,
        compilingGeneration: event.generation,
      };
    case "result": {
      const samples =
        typeof event.durationMs === "number"
          ? [...state.compileSamplesMs, event.durationMs].slice(-MAX_SAMPLES)
          : state.compileSamplesMs;
      const compilingGeneration =
        state.compilingGeneration === event.generation
          ? null
          : state.compilingGeneration;
      const wentBackwards =
        state.readyGeneration !== null &&
        event.generation <= state.readyGeneration;
      const newerCompileInFlight =
        compilingGeneration !== null && compilingGeneration > event.generation;
      if (wentBackwards || newerCompileInFlight) {
        // A newer result is already on screen or imminent; drop this one
        // rather than swapping the GPU material twice.
        return { ...state, compileSamplesMs: samples, compilingGeneration };
      }
      if (!event.ok) {
        return {
          ...state,
          status: "error",
          compilingGeneration,
          lastError: event.error ?? "Material failed to compile",
          compileSamplesMs: samples,
        };
      }
      return {
        ...state,
        // An older generation that still succeeded becomes the last good
        // image, but the document stays dirty until the newest one compiles.
        status: event.generation === state.generation ? "ready" : state.status,
        compilingGeneration,
        readyGeneration: event.generation,
        lastError: null,
        compileSamplesMs: samples,
      };
    }
    case "dispose":
      return { ...createMaterialPreviewState(), compileSamplesMs: state.compileSamplesMs };
  }
}

/** Whether an idle tick should start a compile without the Render button. */
export function shouldAutoCompile(
  state: MaterialPreviewState,
  policy: Omit<MaterialPreviewPolicy, "observedCompileMs">,
): boolean {
  if (state.status !== "dirty") return false;
  if (state.costClass === "expensive") return false;
  if (state.compileSamplesMs.length === 0) return true;
  const worst = Math.max(...state.compileSamplesMs);
  return worst <= policy.frameBudgetMs * AUTO_COMPILE_FRAME_ALLOWANCE;
}

/**
 * Manual Render can refresh the current material even when it is already on
 * screen. It is blocked only while work is already queued or compiling.
 */
export function renderActionEnabled(state: MaterialPreviewState): boolean {
  if (
    state.status === "queued" ||
    state.status === "lowering" ||
    state.status === "gpuCompiling"
  ) {
    return false;
  }
  return true;
}

import { describe, expect, it } from "vitest";
import type { MaterialCostFeatures } from "./lower";
import {
  classifyMaterialCost,
  createMaterialPreviewState,
  materialPreviewReducer,
  renderActionEnabled,
  shouldAutoCompile,
  type MaterialPreviewState,
} from "./preview-state";

function features(
  overrides: Partial<MaterialCostFeatures> = {},
): MaterialCostFeatures {
  return {
    operations: 6,
    textureSamples: 0,
    weight: 8,
    usesDerivatives: false,
    usesSceneDepth: false,
    customBlocks: 0,
    inlinedFunctions: 0,
    ...overrides,
  };
}

const BUDGET = { frameBudgetMs: 1000 / 60, domain: "surface" as const };

function drive(
  state: MaterialPreviewState,
  events: Parameters<typeof materialPreviewReducer>[1][],
): MaterialPreviewState {
  return events.reduce(materialPreviewReducer, state);
}

describe("material cost classification", () => {
  it("calls a small surface graph cheap", () => {
    expect(classifyMaterialCost(features(), BUDGET)).toBe("cheap");
  });

  it("calls a heavy graph expensive on structure alone", () => {
    expect(
      classifyMaterialCost(features({ weight: 400, operations: 120 }), BUDGET),
    ).toBe("expensive");
  });

  it("calls many texture samples expensive", () => {
    expect(classifyMaterialCost(features({ textureSamples: 8 }), BUDGET)).toBe(
      "expensive",
    );
  });

  it("always calls custom GLSL expensive because it is unprofiled", () => {
    expect(classifyMaterialCost(features({ customBlocks: 1 }), BUDGET)).toBe(
      "expensive",
    );
  });

  it("always calls a post-process graph expensive", () => {
    expect(
      classifyMaterialCost(features(), { ...BUDGET, domain: "postProcess" }),
    ).toBe("expensive");
  });

  it("prefers measured compile times over structure once samples exist", () => {
    const slow = classifyMaterialCost(features(), {
      ...BUDGET,
      observedCompileMs: [400, 380],
    });
    expect(slow).toBe("expensive");
    const fast = classifyMaterialCost(features({ weight: 400 }), {
      ...BUDGET,
      observedCompileMs: [3, 4],
    });
    expect(fast).toBe("cheap");
  });

  it("scales the threshold with the frame budget rather than a fixed constant", () => {
    const observedCompileMs = [40, 42];
    expect(
      classifyMaterialCost(features(), { ...BUDGET, observedCompileMs }),
    ).toBe("expensive");
    expect(
      classifyMaterialCost(features(), {
        frameBudgetMs: 1000 / 4,
        domain: "surface",
        observedCompileMs,
      }),
    ).toBe("cheap");
  });
});

describe("material preview state machine", () => {
  it("starts clean with nothing compiled", () => {
    const state = createMaterialPreviewState();
    expect(state.status).toBe("clean");
    expect(state.readyGeneration).toBeNull();
  });

  it("marks an edit dirty and bumps the generation", () => {
    const state = materialPreviewReducer(createMaterialPreviewState(), {
      type: "edit",
      cost: "cheap",
    });
    expect(state.status).toBe("dirty");
    expect(state.generation).toBe(1);
  });

  it("queues a cheap graph once input goes idle", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "idle" },
    ]);
    expect(state.status).toBe("queued");
    expect(state.queuedGeneration).toBe(1);
  });

  it("leaves an expensive graph dirty when input goes idle", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "expensive" },
      { type: "idle" },
    ]);
    expect(state.status).toBe("dirty");
  });

  it("compiles an expensive graph when Render is pressed", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "expensive" },
      { type: "idle" },
      { type: "render" },
    ]);
    expect(state.status).toBe("queued");
    expect(state.queuedGeneration).toBe(1);
  });

  it("never drops the final edit made during a compile", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "idle" },
      { type: "lowerStart", generation: 1 },
      { type: "compileStart", generation: 1 },
      { type: "edit", cost: "cheap" },
      { type: "result", generation: 1, ok: true, durationMs: 5 },
    ]);
    expect(state.readyGeneration).toBe(1);
    expect(state.generation).toBe(2);
    expect(state.status).toBe("dirty");
  });

  it("discards a stale result from an superseded generation", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "idle" },
      { type: "compileStart", generation: 1 },
      { type: "edit", cost: "cheap" },
      { type: "idle" },
      { type: "compileStart", generation: 2 },
      { type: "result", generation: 1, ok: true, durationMs: 5 },
    ]);
    expect(state.readyGeneration).toBeNull();
    expect(state.status).toBe("gpuCompiling");
  });

  it("settles on ready when the newest generation compiles", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "idle" },
      { type: "compileStart", generation: 1 },
      { type: "result", generation: 1, ok: true, durationMs: 5 },
    ]);
    expect(state.status).toBe("ready");
    expect(state.readyGeneration).toBe(1);
  });

  it("records an error but keeps the last good generation", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "idle" },
      { type: "compileStart", generation: 1 },
      { type: "result", generation: 1, ok: true, durationMs: 5 },
      { type: "edit", cost: "cheap" },
      { type: "idle" },
      { type: "compileStart", generation: 2 },
      { type: "result", generation: 2, ok: false, error: "block failed" },
    ]);
    expect(state.status).toBe("error");
    expect(state.lastError).toBe("block failed");
    expect(state.readyGeneration).toBe(1);
  });

  it("collects compile samples so the policy can adapt", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "compileStart", generation: 1 },
      { type: "result", generation: 1, ok: true, durationMs: 12 },
      { type: "edit", cost: "cheap" },
      { type: "compileStart", generation: 2 },
      { type: "result", generation: 2, ok: true, durationMs: 18 },
    ]);
    expect(state.compileSamplesMs).toEqual([12, 18]);
  });

  it("stops auto-compiling after a compile proves slow", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "compileStart", generation: 1 },
      { type: "result", generation: 1, ok: true, durationMs: 900 },
      { type: "edit", cost: "cheap" },
      { type: "idle" },
    ]);
    expect(shouldAutoCompile(state, BUDGET)).toBe(false);
  });

  it("disables Render while clean, queued or compiling", () => {
    const clean = createMaterialPreviewState();
    expect(renderActionEnabled(clean)).toBe(false);
    const queued = drive(clean, [
      { type: "edit", cost: "expensive" },
      { type: "render" },
    ]);
    expect(renderActionEnabled(queued)).toBe(false);
    const compiling = materialPreviewReducer(queued, {
      type: "compileStart",
      generation: 1,
    });
    expect(renderActionEnabled(compiling)).toBe(false);
  });

  it("enables Render while dirty and after an error", () => {
    const dirty = materialPreviewReducer(createMaterialPreviewState(), {
      type: "edit",
      cost: "expensive",
    });
    expect(renderActionEnabled(dirty)).toBe(true);
    const failed = drive(dirty, [
      { type: "render" },
      { type: "compileStart", generation: 1 },
      { type: "result", generation: 1, ok: false, error: "nope" },
    ]);
    expect(renderActionEnabled(failed)).toBe(true);
  });

  it("disables Render once the newest generation is ready", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "compileStart", generation: 1 },
      { type: "result", generation: 1, ok: true, durationMs: 4 },
    ]);
    expect(renderActionEnabled(state)).toBe(false);
  });

  it("resets to clean on dispose", () => {
    const state = drive(createMaterialPreviewState(), [
      { type: "edit", cost: "cheap" },
      { type: "dispose" },
    ]);
    expect(state.status).toBe("clean");
    expect(state.queuedGeneration).toBeNull();
  });
});

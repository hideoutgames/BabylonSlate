import type { AbstractEngine } from "@babylonjs/core";

export interface ForwardLightBudget {
  slots: number;
  source: "webgl2" | "webgl2-minimum" | "non-ubo";
  reservedBlocks: number;
  vertexBlocks: number | null;
  fragmentBlocks: number | null;
  bindings: number | null;
  combinedBlocks: number | null;
}

const budgets = new WeakMap<AbstractEngine, ForwardLightBudget>();

/** Babylon 9.20 does not expose UBO limits through EngineCapabilities. */
export function forwardLightBudget(engine: AbstractEngine): ForwardLightBudget {
  const cached = budgets.get(engine);
  if (cached) return cached;
  // Native PBR/Standard reserve these binding indices even when a compiler
  // optimizes their blocks away. Graph PBR and CEL use the same light budget.
  const reservedBlocks = 3; // Material, Scene, Mesh
  let budget: ForwardLightBudget;
  if (!engine.supportsUniformBuffers) {
    budget = {
      slots: 4,
      source: "non-ubo",
      reservedBlocks: 0,
      vertexBlocks: null,
      fragmentBlocks: null,
      bindings: null,
      combinedBlocks: null,
    };
  } else {
    // Pinned adapter: read the owning WebGL2 context only, never change GL state.
    const gl = (engine as AbstractEngine & { _gl?: WebGL2RenderingContext })
      ._gl;
    let measured = true;
    const limit = (parameter: number | undefined, minimum: number): number => {
      try {
        const value =
          parameter === undefined ? undefined : gl?.getParameter(parameter);
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          return Math.floor(value);
      } catch {
        /* Context recovery uses conservative WebGL2 minima. */
      }
      measured = false;
      return minimum;
    };
    const vertexBlocks = limit(gl?.MAX_VERTEX_UNIFORM_BLOCKS, 12);
    const fragmentBlocks = limit(gl?.MAX_FRAGMENT_UNIFORM_BLOCKS, 12);
    const bindings = limit(gl?.MAX_UNIFORM_BUFFER_BINDINGS, 24);
    const combinedBlocks = limit(gl?.MAX_COMBINED_UNIFORM_BLOCKS, 24);
    budget = {
      // Each LIGHT block is declared in both stages, including unshadowed points.
      slots: Math.max(
        0,
        Math.min(
          vertexBlocks,
          fragmentBlocks,
          bindings,
          Math.floor(combinedBlocks / 2),
        ) - reservedBlocks,
      ),
      source: measured ? "webgl2" : "webgl2-minimum",
      reservedBlocks,
      vertexBlocks,
      fragmentBlocks,
      bindings,
      combinedBlocks,
    };
  }
  budgets.set(engine, budget);
  engine.onContextRestoredObservable.addOnce(() => budgets.delete(engine));
  return budget;
}

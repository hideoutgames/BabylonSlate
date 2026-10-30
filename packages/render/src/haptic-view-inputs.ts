import type { Scene } from "@babylonjs/core";

/**
 * Per-view inputs the light block reads per draw (`hapticViewTerms`), keyed by the render pass drawing: a temporally
 * jittered pass's shadow-filter jitter. Passes nothing registered (captures, mirrors, probes, previews) draw with
 * amplitude 0, today's fixed filter pattern. Looked up per draw with `viewTermsForPass`, as `waterSceneCopyForPass` is.
 */
export interface ViewTerms {
  /** Shadow-filter jitter: 1 shifts the PCF kernel by up to half a texel and turns the Contact Hardening disc. */
  jitterAmplitude: number;
  /** The jitter's frame phase: the temporal jitter's sample index. */
  jitterPhase: number;
}

/** Reads a pass's current terms; a jittered pass's phase changes every frame. */
export type ViewTermsSource = () => ViewTerms;

const registries = new WeakMap<Scene, Map<number, ViewTermsSource>>();
const forced = new WeakMap<Scene, ViewTerms>();
const NONE: ViewTerms = Object.freeze({ jitterAmplitude: 0, jitterPhase: 0 });

/** Registers `renderPassId`'s terms on `scene`; the returned function removes them. */
export function registerViewTerms(scene: Scene, renderPassId: number, source: ViewTermsSource): () => void {
  let registry = registries.get(scene);
  if (!registry) registries.set(scene, (registry = new Map()));
  registry.set(renderPassId, source);
  return () => {
    if (registry.get(renderPassId) === source) registry.delete(renderPassId);
  };
}

/** The terms of the pass drawing on `scene` now (`renderPassId`), or amplitude 0. */
export function viewTermsForPass(scene: Scene, renderPassId: number): ViewTerms {
  return forced.get(scene) ?? registries.get(scene)?.get(renderPassId)?.() ?? NONE;
}

/**
 * Test proofs only: every pass of `scene` draws with `terms` and the light block's programs carry the jitter define
 * whatever the scene's effects; null returns to the scene's own. Set before the Materials prepare.
 */
export function forceViewTerms(scene: Scene, terms: ViewTerms | null): void {
  if (terms) forced.set(scene, terms);
  else forced.delete(scene);
}

/** Whether a proof forces `scene`'s view terms (`forceViewTerms`). */
export function viewTermsForced(scene: Scene): boolean {
  return forced.has(scene);
}

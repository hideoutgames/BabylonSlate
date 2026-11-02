import type { AbstractEngine, Texture } from "@babylonjs/core";
import { Constants } from "@babylonjs/core/Engines/constants";

/**
 * Nearest Texture Filtering (`nearestTextureFiltering` of the project's 2D settings): every texture a Material samples
 * draws nearest on every view of the Engine, so a pixel-art project's 3D surfaces keep their texels sharp. Sprites,
 * tiles and 2D images sample nearest already; render targets, environments, text atlases and engine data keep their
 * own filtering, as they never come through `trackMaterialTexture`.
 *
 * The switch is live and reversible: a loaded texture changes its sampler in place and returns to the mode it loaded
 * with. WebGL reads the sampler from the texture; a WebGPU draw binds it with the texture, so every draw rebinds once
 * after a change, as a frozen Material may skip binding a run of draws (`render-target-capture` does the same). A
 * texture that loads while the switch is on samples nearest from its first draw.
 */
interface EngineNearestTextures {
  enabled: boolean;
  /** Each tracked, loaded texture and the sampling mode it loaded with. */
  readonly textures: Map<Texture, number>;
  readonly listeners: Set<() => void>;
  rebindQueued: boolean;
}

const engines = new WeakMap<AbstractEngine, EngineNearestTextures>();

function stateFor(engine: AbstractEngine): EngineNearestTextures {
  let state = engines.get(engine);
  if (!state) {
    const created: EngineNearestTextures = { enabled: false, textures: new Map(), listeners: new Set(), rebindQueued: false };
    // A restored context recreates each texture with the mode it was created with.
    engine.onContextRestoredObservable.add(() => {
      if (!created.enabled) return;
      for (const [texture, own] of created.textures) apply(texture, own, true);
      queueRebind(engine, created);
    });
    engines.set(engine, created);
    state = created;
  }
  return state;
}

function apply(texture: Texture, own: number, enabled: boolean): void {
  const mode = enabled ? Constants.TEXTURE_NEAREST_SAMPLINGMODE : own;
  if (texture.getInternalTexture() && texture.samplingMode !== mode) texture.updateSamplingMode(mode);
}

/** Rebinds every draw of every Scene on the Engine once, at the next frame. */
function queueRebind(engine: AbstractEngine, state: EngineNearestTextures): void {
  if (state.rebindQueued) return;
  state.rebindQueued = true;
  engine.onBeginFrameObservable.addOnce(() => {
    state.rebindQueued = false;
    for (const scene of engine.scenes) {
      scene.resetCachedMaterial();
      for (const mesh of scene.meshes) {
        for (const subMesh of mesh.subMeshes ?? []) {
          for (const wrapper of subMesh._drawWrappers) if (wrapper) wrapper._forceRebindOnNextCall = true;
        }
      }
    }
  });
}

/** Switches Nearest Texture Filtering for every view of the Engine; the Engine's views redraw. */
export function setNearestTextures(engine: AbstractEngine, enabled: boolean): void {
  const state = stateFor(engine);
  if (state.enabled === enabled) return;
  state.enabled = enabled;
  for (const [texture, own] of state.textures) apply(texture, own, enabled);
  queueRebind(engine, state);
  for (const listener of [...state.listeners]) listener();
}

/** Whether the Engine's Materials sample nearest. */
export function nearestTexturesEnabled(engine: AbstractEngine): boolean {
  return engines.get(engine)?.enabled === true;
}

/** Calls `listener` whenever the Engine's Nearest Texture Filtering switches; returns its removal. */
export function observeNearestTextures(engine: AbstractEngine, listener: () => void): () => void {
  const state = stateFor(engine);
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
}

/**
 * Puts a texture a Material samples under the Engine's Nearest Texture Filtering, once it has loaded (the upload
 * sets the mode it was created with). Idempotent: the cache hands one texture to many leases.
 */
export function trackMaterialTexture(engine: AbstractEngine, texture: Texture, ready: Promise<void> | undefined): void {
  const state = stateFor(engine);
  if (state.textures.has(texture)) return;
  const track = () => {
    if (state.textures.has(texture) || !texture.getInternalTexture()) return;
    state.textures.set(texture, texture.samplingMode);
    texture.onDisposeObservable.addOnce(() => state.textures.delete(texture));
    if (!state.enabled) return;
    apply(texture, texture.samplingMode, true);
    queueRebind(engine, state);
  };
  if (ready) void ready.then(track, () => {});
  else track();
}

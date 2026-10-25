import { StandardMaterialDefines, type AbstractEngine, type AbstractMesh, type MaterialDefines } from "@babylonjs/core";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";

/*
 * Babylon 9.29 `_setLightsForShadow` writes `light.shadowEnabled` around every
 * pass, readiness probe included, for every light that can cast a shadow (so
 * unshadowed lights too: their flag defaults to true). Each write that changes
 * the value walks every mesh and submesh to mark its material light defines
 * dirty, and every material rebuilds those defines on its next draw. Seven
 * lights across three outline masks cost 42 such walks per frame.
 *
 * A pass whose output cannot depend on light or shadow defines has no use for
 * the toggle. These subclasses make `_setLightsForShadow` a no-op: the pass
 * registers no observers and the lights keep their authored flags. They must
 * not be used for a pass that shades with scene lights (see
 * `ManagedShadowObjectRendererTask`, which keeps its own policy).
 */

/** Object renderer for passes whose draws never read light or shadow state. */
export class LightNeutralObjectRendererTask extends FrameGraphObjectRendererTask {
  protected override _setLightsForShadow(): void {}
}

/**
 * Geometry renderer for passes whose attachments (depth, normals, reflectivity,
 * velocity, object ids) are independent of lighting. Materials still compile
 * their normal light defines for the pass, so it follows the main pass's
 * shadow variants instead of forcing a shadowless one.
 */
export class LightNeutralGeometryRendererTask extends FrameGraphGeometryRendererTask {
  protected override _setLightsForShadow(): void {}
}

/*
 * Light-neutral defines (WebGPU world views). A geometry pass's variant still
 * carries the Material's light defines, so a light switching on or off or a
 * shadow starting or stopping asks every lit receiver for a new geometry
 * variant, and on WebGPU for a new render pipeline (about 200 ms each on
 * D3D12, a second on WebKit). An opaque surface's geometry attachments in these
 * passes (depth, normals, velocity, PBR, graph and CEL reflectivity) read no
 * light, so in a registered pass a Material keeps the light defines it was
 * prepared with while only its lights change: its Effect stays, and the
 * Scene's light hooks bind it by its own compiled lights
 * (`fixed-light-binding.ts`). Exceptions: a Standard surface's reflectivity
 * follows its specular light term (`SPECULARTERM`, `standard-reflectivity.ts`),
 * so a pass writing reflectivity prepares its lights as before, and so does a
 * Standard surface no light has reached (its normals, below). A translucent PBR
 * or graph surface writes geometry where its final alpha, which includes its
 * lights' specular (specular over alpha), passes `ALPHATESTVALUE`, so its
 * coverage there follows the lights its kept Effect binds.
 */

/** Per Engine, the registered tests for light-neutral render passes. */
const neutralPasses = new WeakMap<AbstractEngine, Set<(renderPassId: number) => boolean>>();

/** The light inputs a light-neutral pass last prepared `defines` with. */
type LightInputs = { mesh: AbstractMesh; specularSupported: boolean; maxSimultaneousLights: number; disableLighting: boolean };
const prepared = new WeakMap<MaterialDefines, LightInputs>();

/**
 * Registers render passes (`owns`, asked for the current pass: a renderer can recreate its pass ids when it records)
 * whose Materials keep their light defines across light changes; returns the release.
 */
export function registerLightNeutralPasses(engine: AbstractEngine, owns: (renderPassId: number) => boolean): () => void {
  let passes = neutralPasses.get(engine);
  if (!passes) neutralPasses.set(engine, (passes = new Set()));
  const owned = passes;
  // An entry of its own, so releasing one registration never drops another of the same test.
  const entry = (renderPassId: number) => owns(renderPassId);
  owned.add(entry);
  return () => { owned.delete(entry); };
}

function lightNeutralPass(engine: AbstractEngine, renderPassId: number): boolean {
  const passes = neutralPasses.get(engine);
  if (passes) for (const owns of passes) if (owns(renderPassId)) return true;
  return false;
}

/**
 * Whether `defines`, prepared in the current render pass, keep their light defines instead of preparing them again:
 * in a light-neutral pass, once prepared there with the same mesh and light inputs (a light change, not another
 * Material or lighting mode; `disableLighting` includes the Scene's lights being off), and for a Standard surface once a
 * light has reached it. Otherwise records these inputs, and the caller prepares the lights. `eligible`: the
 * Scene binds an Effect by its own compiled lights (Babylon's light path, not seats); a pass that is not forgets.
 */
export function keepsLightDefines(
  engine: AbstractEngine,
  mesh: AbstractMesh,
  defines: MaterialDefines & Record<string, unknown>,
  specularSupported: boolean,
  maxSimultaneousLights: number,
  disableLighting: boolean,
  eligible: boolean,
): boolean {
  if (!lightNeutralPass(engine, engine.currentRenderPassId)) return false;
  if (!eligible || (defines instanceof StandardMaterialDefines && defines.PREPASS_REFLECTIVITY)) {
    prepared.delete(defines);
    return false;
  }
  const last = prepared.get(defines);
  if (last && last.mesh === mesh && last.specularSupported === specularSupported &&
    last.maxSimultaneousLights === maxSimultaneousLights && last.disableLighting === disableLighting) {
    // A Standard surface last prepared with no light compiled without vertex normals (`_needNormals`, which a light or
    // a Fresnel parameter sets and Babylon keeps), so it writes derivative normals: its lights are prepared as before
    // until one reaches it.
    return !(defines instanceof StandardMaterialDefines) || defines._needNormals;
  }
  prepared.set(defines, { mesh, specularSupported, maxSimultaneousLights, disableLighting });
  return false;
}

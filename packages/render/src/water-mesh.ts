import {
  Matrix, Mesh, PBRMaterial, Ray, Vector3, VertexBuffer,
  type AbstractMesh, type Material, type PickingInfo, type Scene, type TrianglePickingPredicate,
} from "@babylonjs/core";
import {
  createDefaultWaterDefinition, createWaterBlendSample, createWaterWaveOutput, evaluateWaterBlend, evaluateWaterVertex, normalizeWaterBody, normalizeWaterDefinition,
  waterBankFadeLength, waterEulerianGradient, waterFootprint, waterHorizontalEnvelope, waterMovesSideways, waterSpectrum, waterWaveEnvelope,
  type WaterBodyProperties, type WaterDefinition,
} from "@haptic/core";
import { inActiveView } from "./active-view";
import { updateDynamicMaterialBounds } from "./material-bounds";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import { requestWaterFft, updateSceneWaterFft } from "./water-fft";
import {
  applyWaterMaterialScalars, configureWaterMaterial, contactRange, setMeshVertexWaves, setWaterGridOffsetSource, waterGridOffset, WaterMaterialPlugin,
  WaterVertexWaves,
} from "./water-material";
import { WaterContactField } from "./water-contact-field";
import { WaterField, type WaterFieldSurface } from "./water-field";
import { WaterReflection } from "./water-reflection";
import { materialSceneCopyUse, materialUsesWaterFields, setMeshWaterNodeSurface } from "./water-node-blocks";
import { materialHasWaterWaves } from "./water-waves-block";
import { advanceBlendRebuild, markBlendDirty, syncSceneBlend } from "./water-mesh-blend";
import { blendNormals, globalReachRows, liveBlendInputs, placeBlend, placeGlobalBlend, sceneBlends } from "./water-mesh-blend-data";
import { REBUILT, RECENTRED, syncQuality, updateLayout } from "./water-mesh-grid";
import { centredGrid, restDataRange, uploadRestData } from "./water-mesh-rest-data";
import { L_CX, L_CZ, LAYOUT_STATE, NO_PARTNERS, type Surface } from "./water-mesh-surface";
import { advanceSceneWaterClock, deleteSceneWaterClock, sceneWaterTime } from "./water-scene-clock";
export { WATER_BLEND_DEADLINE_MS, WATER_BLEND_FRAME_BUDGET_MS, WATER_BLEND_REFRESH_MS } from "./water-mesh-blend";
export {
  WATER_FINITE_CELL_BUDGET, WATER_GLOBAL_CELL_BUDGET, WATER_OCEAN_CELL_BUDGET, WATER_RIVER_COLUMN_BUDGET, WATER_RIVER_ROW_BUDGET,
} from "./water-mesh-grid";
export { sampleSceneWaterFrame, setSceneWaterTime } from "./water-scene-clock";

let surfaceIds = 0;
const surfaces = new WeakMap<Scene, Set<Surface>>();
const surfaceByMesh = new WeakMap<AbstractMesh, Surface>();
/**
 * Enabled built-in (WaterMaterialPlugin) surfaces per Scene whose asset can sample a scene copy, so admission stays
 * O(1) per frame. An in-place asset edit (`updateWaterMeshDefinition`) moves the surface's count to the new values;
 * enabled state (an authored Enabled off, or a deactivated actor) is followed by `syncCopyIntent`.
 */
const copyIntents = new WeakMap<Scene, { refracting: number; reflecting: number }>();
const reflections = new WeakMap<Scene, WaterReflection>();

/** Milliseconds a water surface stays disabled before it gives back its terrain and contact textures (GPU memory). */
export const WATER_RELEASE_DISABLED_MS = 2000;
/** Released surfaces that restore their terrain and contact textures in one frame when enabled again. */
export const WATER_RESTORES_PER_FRAME = 2;

/**
 * Called once per scene render; runtime water advances only with the worker clock. Every enabled surface advances its
 * shader clock and keeps its grid and bounds current. Surfaces neither drawn last frame nor inside an active camera's
 * frustum skip their CPU vertex work (Custom Material water), their terrain and contact refreshes and their FFT detail
 * request until they are; the FFT simulations then update once for the whole scene. An editor-time clock advances by
 * the last frame's time (at most 0.1 s). An `early` run (`settleSceneWater`) precedes the frame's own: it leaves the
 * clock and each surface's drawn flag, which the frame's own run consumes, to it.
 */
export function updateSceneWater(scene: Scene, early = false): void {
  const time = advanceSceneWaterClock(scene, early);
  reflections.get(scene)?.sync();
  const entries = surfaces.get(scene);
  if (!entries) return;
  syncSceneBlend(scene, entries);
  const now = performance.now();
  const blendState = sceneBlends.get(scene);
  if (blendState) blendState.spent = 0;
  let restored = 0;
  for (const surface of entries) {
    const enabled = surface.mesh.isEnabled();
    surface.seenEnabled = enabled;
    syncCopyIntent(scene, surface);
    if (!enabled) {
      // Water disabled for a while gives back its terrain and contact textures (their CPU data stays); enabling it
      // uploads them again, rebuilding only what changed meanwhile.
      if (surface.disabledSince < 0) surface.disabledSince = now;
      else if (!surface.released && now - surface.disabledSince >= WATER_RELEASE_DISABLED_MS) {
        surface.field?.releaseTexture(); surface.contacts?.releaseTexture(); surface.released = surface.field !== null;
      }
      continue;
    }
    surface.disabledSince = -1;
    syncCustomMaterial(surface);
    placeSurface(surface, time, now);
    // Re-enabled water restores its textures after its placement, a few surfaces per frame (streaming in a section that
    // enables many bodies spreads the work); the rest draw without them until their turn.
    if (surface.released && restored < WATER_RESTORES_PER_FRAME) {
      restored++;
      surface.released = false; surface.field?.restore(); surface.contacts?.restore(now);
    }
    const active = surface.drawn || inActiveView(scene, surface.mesh);
    // Water drawn only by another pass (a capture, a planar reflection) and outside the active frusta keeps its CPU work
    // running in the frame's own run, which an early run must not use up.
    if (!early) surface.drawn = false;
    if (!active) continue;
    animateSurface(surface, time);
    // Waves never rebake either field: the shader reads contacts at each fragment's rendered height.
    surface.field?.update();
    surface.contacts?.update(now);
    // Visible water a spectrum displaces asks for it (it is already known to be drawn or in view); the simulations run
    // once below, after every request.
    if (surface.plugin || surface.waves) requestWaterFft(scene, surface.mesh, surface.water, surface.mesh.isVisible && surface.mesh.visibility > 0);
  }
  updateSceneWaterFft(scene, time);
}

/** Whether a surface was created, or enabled or disabled (itself or through an ancestor), since the water update last ran. */
function waterUnsettled(scene: Scene): boolean {
  const entries = surfaces.get(scene);
  if (entries) for (const surface of entries) if (surface.seenEnabled !== surface.mesh.isEnabled()) return true;
  return false;
}

/**
 * Runs the water update ahead of the frame's strict readiness probes (an `early` run: it leaves the clock and the drawn
 * flags to the frame's own run), so a surface's blend, placement (`flat`), enablement and the sky reflection view are
 * final when its variants are first requested. The before-render update runs after those probes, and every define it
 * then changes compiles another variant. Copy intent is counted when the surface is created and re-synced only when its
 * enablement changes (or, for an edited asset, by `updateWaterMeshDefinition`). Idempotent with the before-render
 * update. Without `force` it does nothing unless a surface was created or its enablement changed since the last update
 * (an editor edit or drop, a Play spawn, a published scene stream); a load forces it.
 */
export function settleSceneWater(scene: Scene, force = false): void {
  if (force || waterUnsettled(scene)) updateSceneWater(scene, true);
}

const waveOut = createWaterWaveOutput(), slopeOut = new Float64Array(2);
const toLocalNormal = new Matrix();
const up = new Vector3(), across = new Vector3(), along = new Vector3(), boundsMin = new Vector3(), boundsMax = new Vector3(), boundsPad = new Vector3();
const point = new Vector3(), localNormal = new Vector3();

/**
 * Culling bounds stay fixed while waves animate: the rest extents padded by the wave envelopes (horizontally only for
 * finite bodies, whose edges move with Gerstner waves), converted to local space. GPU-displaced vertices stay inside
 * them, fields keyed on the mesh bounds never rebuild per frame, and no per-frame extents pass runs.
 */
function updateBounds(s: Surface, world: Matrix, inverse: Matrix, recentred: boolean): void {
  s.boundsDirty = false;
  if (!s.base.length) return;
  // A blending surface can take a rougher neighbour's waves near the seam: pad by its largest swell scale.
  const blendScale = s.blend ? s.blend.heightScale * (s.plugin?.waveScale ?? s.body.waveScale) : s.body.waveScale;
  const vertical = waterWaveEnvelope(s.water, blendScale);
  const horizontal = s.body.kind === "global" ? 0 : waterHorizontalEnvelope(s.water, blendScale);
  const m = inverse.m;
  boundsPad.set(
    Math.abs(m[0]!) * horizontal + Math.abs(m[4]!) * vertical + Math.abs(m[8]!) * horizontal,
    Math.abs(m[1]!) * horizontal + Math.abs(m[5]!) * vertical + Math.abs(m[9]!) * horizontal,
    Math.abs(m[2]!) * horizontal + Math.abs(m[6]!) * vertical + Math.abs(m[10]!) * horizontal,
  );
  updateDynamicMaterialBounds(s.mesh, boundsMin.copyFrom(s.restMin).subtractInPlace(boundsPad), boundsMax.copyFrom(s.restMax).addInPlace(boundsPad));
  const subMeshes = s.mesh.subMeshes ?? [];
  // Padded sub-mesh bounds that a recentre translated keep their padding; new or rebuilt ones rescan their vertices.
  const shift = recentred && subMeshes.length === s.boundedSubMeshes && (subMeshes[0] ?? null) === s.boundedFirst;
  for (const subMesh of subMeshes) if (!subMesh.IsGlobal) {
    if (shift) {
      const info = subMesh.getBoundingInfo();
      boundsMin.copyFrom(info.minimum).addInPlaceFromFloats(s.shift[0]!, 0, s.shift[1]!);
      boundsMax.copyFrom(info.maximum).addInPlaceFromFloats(s.shift[0]!, 0, s.shift[1]!);
      info.reConstruct(boundsMin, boundsMax, world);
      continue;
    }
    const info = subMesh.refreshBoundingInfo(s.base).getBoundingInfo();
    boundsMin.copyFrom(info.minimum).subtractInPlace(boundsPad); boundsMax.copyFrom(info.maximum).addInPlace(boundsPad);
    info.reConstruct(boundsMin, boundsMax, world);
  }
  s.boundedSubMeshes = subMeshes.length; s.boundedFirst = subMeshes[0] ?? null;
}

/**
 * Every frame for every enabled surface, allocation-free unless the grid is rebuilt: advances the shader clock and keeps
 * the grid and padded bounds current. Per-vertex rest data (base normals, current, bank distance, depth, spacing) depend
 * only on the grid and the volume's rotation and scale, so only a rebuilt grid or a rotated or scaled volume recomputes
 * and uploads them. On the GPU path a translated volume uploads nothing (the shader reads world positions) and a Global
 * recentre uploads nothing (it moves `gridOffset`; a blending grid rewrites only the rows near a neighbour); the CPU path re-derives its world rest points for its next animation step.
 * A blending body's refresh for moved neighbours is not placed here at once: `advanceBlendRebuild` spreads it over
 * frames and swaps it in when it is complete.
 */
function placeSurface(s: Surface, time: number, now: number): void {
  if (s.plugin) s.plugin.time = time;
  else if (s.waves) s.waves.time = time;
  const placed = s.placed, m = s.mesh.computeWorldMatrix(!s.mesh.isSynchronized()).m;
  let linear = false, translated = false;
  for (let i = 0; i < 12; i++) if (placed[i] !== m[i]) { linear = true; break; }
  for (let i = 12; i < 16; i++) if (placed[i] !== m[i]) { translated = true; break; }
  if (linear || translated) {
    // A degenerate (zero-scale) transform keeps the last valid placement until it becomes invertible again.
    const world = s.mesh.getWorldMatrix();
    if (Math.abs(world.determinant()) < 1e-12) return;
    s.world.copyFrom(world); world.invertToRef(s.inverse);
    for (let i = 0; i < 16; i++) placed[i] = m[i]!;
    // A level body can take the view's planar reflection; tilting a volume out of level recompiles without it.
    if (linear && s.plugin) s.plugin.flat = !restVaries(s);
  }
  const world = s.world, inverse = s.inverse;
  syncQuality(s);
  const layout = updateLayout(s, world, inverse);
  const centred = centredGrid(s);
  s.gridOffset[0] = centred ? s.layoutState[L_CX]! : 0; s.gridOffset[1] = centred ? s.layoutState[L_CZ]! : 0;
  const rebuilt = linear || layout === REBUILT;
  // A new grid or a moved Global grid writes its blend data at once, from the neighbours as they are now: a refresh
  // begun for the grid it replaces is dropped.
  if (s.stage?.active && (rebuilt || layout === RECENTRED)) s.stage.active = false;
  // A blending surface lifts its grid to the blended rest height before its bounds are padded. A blending Global grid
  // on the GPU path that only recentred rewrites and uploads only the rows near a neighbour (`placeGlobalBlend`): open
  // water's own rest data are uniform everywhere else.
  const globalRows = s.blend !== null && s.gpu && s.body.kind === "global" && !rebuilt && layout === RECENTRED;
  if (globalRows) placeGlobalBlend(s);
  else if (s.blend && (rebuilt || layout === RECENTRED)) placeBlend(s, world, inverse);
  const landed = s.stage?.active === true && advanceBlendRebuild(s, now);
  const subMeshes = s.mesh.subMeshes ?? [];
  // A translation alone needs no new bounds: Babylon moves the local bounds with the world matrix.
  if (rebuilt || layout === RECENTRED || s.boundsDirty || subMeshes.length !== s.boundedSubMeshes || (subMeshes[0] ?? null) !== s.boundedFirst) {
    updateBounds(s, world, inverse, !rebuilt && !s.boundsDirty && layout === RECENTRED);
  }
  if (globalRows) return;
  if (rebuilt || (layout === RECENTRED && s.blend)) {
    placeRestData(s);
    return;
  }
  if (landed) return;
  if ((layout === RECENTRED || translated) && !s.gpu) {
    for (let i = 0; i < s.base.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(s.base[i]!, s.base[i + 1]!, s.base[i + 2]!, world, point).toArray(s.worldBase, i);
    }
    s.time = null;
  }
}

/** Recomputes and uploads every per-vertex rest input of the current grid and placement. */
function placeRestData(s: Surface): void {
  const blended = s.blend !== null && s.blendRest.length === s.base.length * 2;
  restDataRange(s, s, s.world, s.inverse, blended, 0, s.base.length / 3);
  if (blended) {
    blendNormals(s, 0, s.base.length / 3);
    if (s.body.kind === "global") {
      const state = sceneBlends.get(s.mesh.getScene());
      if (state) globalReachRows(s, liveBlendInputs(state, s.blend!.self, s.world, s.inverse), s.blendRows);
    }
  }
  uploadRestData(s, blended);
}

/** CPU path only: displaces the rest grid with `evaluateWaterVertex` at the simulation time and uploads it. */
function animateSurface(s: Surface, time: number): void {
  if (s.gpu || s.time === time || !s.base.length) return;
  const world = s.world, inverse = s.inverse;
  world.transposeToRef(toLocalNormal);
  // World-axis displacements (vertical waves, Gerstner X/Z offsets) expressed in the mesh's local space.
  Vector3.TransformNormalFromFloatsToRef(0, 1, 0, inverse, up);
  Vector3.TransformNormalFromFloatsToRef(1, 0, 0, inverse, across);
  Vector3.TransformNormalFromFloatsToRef(0, 0, 1, inverse, along);
  const spectrum = waterSpectrum(s.water), scale = s.plugin?.waveScale ?? s.body.waveScale, o = waveOut, blend = s.blend ? s.blendData : null;
  // Finite bodies fade the horizontal offset to zero at their banks, exactly as queries do (`waterBankGain`).
  const fadeLength = s.body.kind === "global" ? 0 : waterBankFadeLength(s.water, scale), gerstner = waterMovesSideways(spectrum, scale);
  for (let i = 0; i < s.base.length; i += 3) {
    const x = s.base[i]!, y = s.base[i + 1]!, z = s.base[i + 2]!;
    const d = i / 3 * 4, v = i / 3 * 2;
    // Forward evaluation at this vertex's world rest point: the mesh never inverts, queries do.
    // Blending scales the swell height and the Gerstner offset (and its fade length) by the vertex's blend data.
    const heightScale = blend ? blend[d]! : 1, offsetScale = blend ? blend[d + 1]! : 1;
    evaluateWaterVertex(spectrum, s.worldBase[i]!, s.worldBase[i + 2]!, time, scale, s.data[d + 1]!, fadeLength * offsetScale, s.bankGradient[v]!, s.bankGradient[v + 1]!, o);
    const height = o[0]! * heightScale, offsetX = o[1]! * offsetScale, offsetZ = o[2]! * offsetScale;
    s.offsets[v] = offsetX; s.offsets[v + 1] = offsetZ;
    s.positions[i] = x + up.x * height + across.x * offsetX + along.x * offsetZ;
    s.positions[i + 1] = y + up.y * height + across.y * offsetX + along.y * offsetZ;
    s.positions[i + 2] = z + up.z * height + across.z * offsetX + along.z * offsetZ;
    // Eulerian world slope J⁻ᵀ(∇rest + ∇H), the same normal a query at the displaced point reports.
    const ny = Math.max(1e-6, s.baseNormals[i + 1]!);
    waterEulerianGradient(o, o[3]! - s.baseNormals[i]! / ny, o[4]! - s.baseNormals[i + 2]! / ny, slopeOut);
    localNormal.set(-slopeOut[0]!, 1, -slopeOut[1]!);
    Vector3.TransformNormalToRef(localNormal, toLocalNormal, localNormal); localNormal.normalize().toArray(s.normals, i);
    s.data[d] = height; s.data[d + 3] = time;
  }
  s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, false);
  s.mesh.updateVerticesData(VertexBuffer.NormalKind, s.normals);
  s.mesh.updateVerticesData("slateWaterData", s.data);
  // Only built-in shading reads the offsets; calm water uploads its zeros once.
  if (s.plugin && (gerstner || !s.offsetsZero)) {
    s.mesh.updateVerticesData("slateWaterOffset", s.offsets);
    s.offsetsZero = !gerstner;
  }
  s.time = time;
}

/** A full update outside the frame loop: creation, handle edits and path switches. */
function refreshSurface(s: Surface, time: number): void {
  placeSurface(s, time, performance.now());
  animateSurface(s, time);
}

const scratch = new Vector3();
const fieldSample = createWaterBlendSample();
/**
 * Rest surface height (no waves) at a world X/Z, or null outside the body's footprint (unless `beyond`). A blending
 * surface answers with the blended rest height inside the blended shoreline.
 */
function waterSurfaceY(s: Surface, x: number, z: number, beyond = false): number | null {
  const state = s.blend ? sceneBlends.get(s.mesh.getScene()) : undefined;
  if (state && s.blend && evaluateWaterBlend(state.index, s.blend.self, x, s.world.m[13]!, z, fieldSample) && (beyond || fieldSample.union >= 0)) {
    return fieldSample.restHeight;
  }
  Vector3.TransformCoordinatesFromFloatsToRef(x, s.world.m[13]!, z, s.inverse, scratch);
  const footprint = waterFootprint(s.body, scratch.x, scratch.z);
  if (!footprint.inside && !beyond) return null;
  Vector3.TransformCoordinatesFromFloatsToRef(scratch.x, footprint.height, scratch.z, s.world, scratch);
  return scratch.y;
}

/** Rivers and volumes tilted out of the horizontal have a rest height that varies across the body. */
const restVaries = (s: Surface) => s.body.kind === "river" || Math.abs(s.world.m[1]!) > 1e-9 || Math.abs(s.world.m[9]!) > 1e-9 || s.blend?.restVaries === true;

/**
 * Whether any live water in `scene` samples the scene copy under the given device-effective features (`copyUse`):
 * refraction-style reads while refraction runs, or object reflections while a screen-space march runs. The scene-level
 * form of `waterMeshSamplesSceneCopy`; O(1).
 */
export function sceneWaterSamplesSceneCopy(scene: Scene, refraction: boolean, screenSpace: boolean): boolean {
  const intents = copyIntents.get(scene);
  return intents !== undefined && ((refraction && intents.refracting > 0) || (screenSpace && intents.reflecting > 0));
}

const COPY_REFRACTS = 1, COPY_REFLECTS = 2;
/**
 * A surface's scene-copy use: built-in water's asset (Refraction above 0, Object Reflections), a Custom Material's water
 * nodes (Water Scene Color and Water Depth Fade refract; Water Reflection marches with the asset's Object Reflections).
 */
function copyUse(s: Surface): number {
  if (!s.plugin) return s.nodeCopyUse & (COPY_REFRACTS | (s.water.objectReflections ? COPY_REFLECTS : 0));
  return (s.water.refraction > 0 ? COPY_REFRACTS : 0) | (s.water.objectReflections ? COPY_REFLECTS : 0);
}

/**
 * Counts a surface's copy intent only while it is enabled, itself and through its ancestors (a deactivated actor
 * disables its children without notifying them, so the water update checks every frame: O(1), no allocation), and
 * follows an asset or Custom Material edit. Disabled water therefore keeps no copy, own pair or ledger charge planned;
 * enabling it re-plans the view's graph.
 */
function syncCopyIntent(scene: Scene, s: Surface): void {
  const counted = !s.mesh.isDisposed() && s.mesh.isEnabled() ? copyUse(s) : 0;
  if (counted === s.copyCounted) return;
  countCopyIntent(scene, s.copyCounted, -1);
  countCopyIntent(scene, counted, 1);
  s.copyCounted = counted;
}

function countCopyIntent(scene: Scene, use: number, delta: 1 | -1): void {
  let intents = copyIntents.get(scene);
  if (!intents) { intents = { refracting: 0, reflecting: 0 }; copyIntents.set(scene, intents); }
  if (use & COPY_REFRACTS) intents.refracting = Math.max(0, intents.refracting + delta);
  if (use & COPY_REFLECTS) intents.reflecting = Math.max(0, intents.reflecting + delta);
}

/**
 * Whether `mesh` is built-in water (the `WaterMaterialPlugin`, not a Custom Material). Its drawn variant depends on the
 * render pass that draws it (the scene-copy pass compiles refraction, the others and the depth pre-pass do not), which
 * a mesh-level warm-up or a pre-graph probe cannot know: only the view's graph probes it, under the real pass.
 */
export function isBuiltInWaterMesh(mesh: AbstractMesh): boolean {
  return (mesh.metadata as { slateWater?: unknown } | null)?.slateWater === true && surfaceByMesh.get(mesh)?.plugin != null;
}

/**
 * Whether `mesh` is water that can sample the view's scene copy: built-in water whose asset has Refraction above zero
 * while refraction runs, or Object Reflections while a screen-space march runs, or alpha-blended Custom Material water
 * whose water nodes read the copy (`copyUse`; an opaque Material draws before the copy exists). A per-frame check: no
 * allocation.
 */
export function waterMeshSamplesSceneCopy(mesh: AbstractMesh, refraction: boolean, screenSpace: boolean): boolean {
  if ((mesh.metadata as { slateWater?: unknown } | null)?.slateWater !== true) return false;
  const surface = surfaceByMesh.get(mesh);
  if (!surface || (!surface.plugin && (!surface.nodeCopyUse || !mesh.material?.needAlphaBlendingForMesh(mesh)))) return false;
  const use = copyUse(surface);
  return (refraction && (use & COPY_REFRACTS) !== 0) || (screenSpace && (use & COPY_REFLECTS) !== 0);
}

/** The live body of a built water mesh, or null for other meshes. */
export function waterMeshBody(mesh: Mesh): Readonly<WaterBodyProperties> | null {
  return surfaceByMesh.get(mesh)?.body ?? null;
}

/**
 * Whether a built water mesh's rest height varies across it (a river, or a volume tilted out of level), the same
 * test its WaterField and contacts use; null for other meshes. A level body rests on its local y = 0 plane.
 */
export function waterMeshRestVaries(mesh: Mesh): boolean | null {
  const surface = surfaceByMesh.get(mesh);
  return surface ? restVaries(surface) : null;
}

/**
 * Reshape a water mesh in place, e.g. while an editor handle drags. The authored
 * component remains the source of truth; a committed change rebuilds the mesh.
 */
export function updateWaterMeshBody(mesh: Mesh, input: unknown): boolean {
  const surface = surfaceByMesh.get(mesh);
  if (!surface) return false;
  Object.assign(surface.body, normalizeWaterBody(input, surface.body.kind));
  surface.version++; surface.placed.fill(NaN);
  markBlendDirty(surface);
  mesh.setEnabled(surface.body.enabled);
  syncCopyIntent(mesh.getScene(), surface);
  refreshSurface(surface, sceneWaterTime(mesh.getScene()));
  surface.field?.update(true);
  surface.contacts?.update(performance.now(), true);
  return true;
}

/**
 * Switch a built-in water surface between GPU vertex waves (the default) and CPU-displaced vertices, e.g. for a
 * CPU-vs-GPU parity capture. Custom Material water takes its path from its graph (`syncCustomMaterial`) and is not
 * switched here. Returns false for other meshes.
 */
export function setWaterGpuWaves(mesh: Mesh, enabled: boolean): boolean {
  const surface = surfaceByMesh.get(mesh);
  if (!surface?.plugin) return false;
  setSurfaceGpu(surface, enabled);
  return true;
}

/**
 * Moves a surface between the GPU path (a static rest grid its vertex shader displaces) and the CPU path (vertices
 * displaced and uploaded every simulation step). The vertex data layout changes with the path, so every static
 * attribute is rewritten.
 */
function setSurfaceGpu(s: Surface, enabled: boolean): void {
  if (s.gpu === enabled) return;
  s.gpu = enabled;
  if (s.plugin) {
    s.plugin.gpuWaves = enabled;
    // The previous shader must never draw the new vertex layout (it would displace CPU-displaced vertices again): skip
    // the surface while the new variant compiles, then restore shader hot swapping at its first bind.
    const material = s.mesh.material;
    if (material?.allowShaderHotSwapping) {
      material.allowShaderHotSwapping = false;
      material.onBindObservable.addOnce(() => { material.allowShaderHotSwapping = true; });
    }
  } else {
    // A Custom Material's Water Waves node reads this swell for the mesh it draws.
    s.waves = enabled ? new WaterVertexWaves(s.water, s.body) : null;
    setMeshVertexWaves(s.mesh, s.waves);
  }
  s.placed.fill(NaN);
  refreshSurface(s, sceneWaterTime(s.mesh.getScene()));
}

/**
 * Custom Material water follows its graph: a Water Waves node (`WaterWavesBlock`) puts the swell on the GPU path, any
 * other graph keeps the CPU path. The mesh's material can be replaced under it (a Material edit recompiles and the
 * library rebinds every mesh that held the old one, which may add or remove the node), so the path is chosen again
 * whenever the mesh holds another material, in the frame update that precedes the draw: the new material never draws the
 * other path's vertex data. An unchanged material costs one comparison.
 */
function syncCustomMaterial(s: Surface): void {
  if (s.plugin || s.mesh.material === s.material) return;
  s.material = s.mesh.material;
  setSurfaceGpu(s, materialHasWaterWaves(s.material));
  syncNodeSurface(s);
}

/**
 * What a Custom Material's water nodes read follows its graph: its scene-copy use, and the terrain and contact fields,
 * built the first time a graph reads them (Water Foam, Water Depth Fade) and kept for the surface's life.
 */
function syncNodeSurface(s: Surface): void {
  if (!s.nodes) return;
  const use = materialSceneCopyUse(s.material);
  s.nodeCopyUse = (use.refraction ? COPY_REFRACTS : 0) | (use.reflection ? COPY_REFLECTS : 0);
  if (!s.field && materialUsesWaterFields(s.material)) attachFields(s);
  s.nodes.field = s.field;
  s.nodes.contacts = s.contacts;
}

/** Builds the surface's terrain and contact fields (built-in water always has them; see `syncNodeSurface`). */
function attachFields(surface: Surface): void {
  const { mesh, water, body, plugin } = surface, scene = mesh.getScene();
  const fieldSurface: WaterFieldSurface = {
    mesh, unbounded: body.kind === "global",
    // Read live: `updateWaterMeshDefinition` edits the shared definition in place.
    get contactRange() { return contactRange(water); },
    // The envelope bounds |H| exactly; the margin keeps the outermost contact layers off the clamp.
    get amplitude() { return waterWaveEnvelope(water, body.waveScale) + 0.05; },
    // Contact Resolution caps the contact texture's cells per side; a change rebuilds it.
    get contactCells() { return sceneWaterQualityDeviceClamp(scene).quality.contactResolution; },
    // A blending surface discards the water a neighbour owns (the share margin is negative there), and what lies
    // beyond the blended shoreline: contacts in either are never seen. A point the blend cannot place counts as drawn.
    get drawStamp() { return sceneBlends.get(scene)?.index.revision ?? 0; },
    draws: (x, z) => {
      const state = surface.blend ? sceneBlends.get(scene) : undefined;
      if (!state || !surface.blend) return true;
      return !evaluateWaterBlend(state.index, surface.blend.self, x, surface.world.m[13]!, z, fieldSample) || (fieldSample.margin >= 0 && fieldSample.union >= 0);
    },
    surfaceY: (x, z) => waterSurfaceY(surface, x, z),
    get restVaries() { return restVaries(surface); },
    restY: (x, z) => waterSurfaceY(surface, x, z, true)!,
  };
  const field = new WaterField(scene, fieldSurface), contacts = new WaterContactField(scene, fieldSurface);
  surface.field = field; surface.contacts = contacts;
  if (plugin) { plugin.field = field; plugin.contacts = contacts; }
  field.update(true);
  contacts.update(performance.now(), true);
  mesh.onDisposeObservable.addOnce(() => { field.dispose(); contacts.dispose(); });
}

/**
 * Apply an edited Water definition to a built surface without rebuilding it, e.g. while a Details value scrubs.
 * Built-in shading reads the definition on every bind (swell constants with Steepness, Wave Model, Peak Sharpness and
 * Wave Seed, Color Variation, the Refraction amount and the FFT band's Detail Waves gain) and the CPU waves on every
 * resample, so this re-applies the material's own scalars (Roughness, Reflection Strength), re-evaluates once the
 * defines that follow the asset (Wave Model, Stylized Look, a feature term crossing zero, Refraction or Detail Waves
 * crossing zero, Object Reflections), moves the surface's scene-copy intent to the new values, re-pads the culling
 * bounds for the new wave envelopes, refreshes the contact range of both fields and resamples CPU vertices, also under a
 * paused clock. A Wave Length edit changes the grid step, so the placement below builds a new rest grid in place
 * (Global Water too). The scene's water clock keeps running. Returns false, changing nothing, for other meshes and for
 * edits that need a rebuild: Custom Material replaces the shader.
 */
export function updateWaterMeshDefinition(mesh: Mesh, input: unknown): boolean {
  const surface = surfaceByMesh.get(mesh);
  if (!surface) return false;
  const water = surface.water, next = normalizeWaterDefinition(input);
  if (next.materialGuid !== water.materialGuid) return false;
  const scene = mesh.getScene(), range = contactRange(water);
  Object.assign(water, next);
  // The copy intent counts this surface by its asset's Refraction and Object Reflections.
  syncCopyIntent(scene, surface);
  if (surface.plugin && mesh.material instanceof PBRMaterial) {
    applyWaterMaterialScalars(mesh.material, water);
    surface.plugin.definitionChanged();
  }
  surface.boundsDirty = true;
  markBlendDirty(surface);
  // A paused clock repeats the cached time, which would otherwise skip the CPU resample.
  surface.time = null;
  refreshSurface(surface, sceneWaterTime(scene));
  // The terrain field's change key omits the contact range its margin uses; the contact field notices range and
  // wave-envelope changes itself.
  surface.field?.update(contactRange(water) !== range);
  surface.contacts?.update(performance.now());
  return true;
}

/**
 * Babylon's CPU picks (`scene.pick`, `pickWithRay`, `Ray.intersectsMesh`) test the uploaded vertex buffer, which a GPU
 * Global grid keeps relative to its snapped centre (`Surface.gridOffset`). With a non-zero offset the bounds (already the
 * true local extents) are tested with the ray as given, then the triangles with the ray moved back by the local offset, and
 * the hit point is moved forward by its world-space form. A translation leaves the hit distance unchanged.
 */
function intersectGridOffset(
  mesh: Mesh, offset: Float64Array, ray: Ray, fastCheck?: boolean, trianglePredicate?: TrianglePickingPredicate, onlyBoundingInfo?: boolean,
  worldToUse?: Matrix, skipBoundingInfo?: boolean,
): PickingInfo {
  const intersects = Mesh.prototype.intersects;
  if ((offset[0] === 0 && offset[1] === 0) || onlyBoundingInfo) return intersects.call(mesh, ray, fastCheck, trianglePredicate, onlyBoundingInfo, worldToUse, skipBoundingInfo);
  if (!skipBoundingInfo) {
    const bounds = intersects.call(mesh, ray, fastCheck, trianglePredicate, true, worldToUse);
    if (!bounds.hit) return bounds;
  }
  const moved = new Ray(new Vector3(ray.origin.x - offset[0]!, ray.origin.y, ray.origin.z - offset[1]!), ray.direction, ray.length);
  const hit = intersects.call(mesh, moved, fastCheck, trianglePredicate, false, worldToUse, true);
  if (hit.hit && hit.pickedPoint) {
    const world = waterGridOffset(mesh);
    hit.pickedPoint.addInPlaceFromFloats(world[0]!, world[1]!, world[2]!);
  }
  return hit;
}

/** Finite volumes keep fixed bounds; only Global Water Volume follows the camera. */
export function createWaterMesh(scene: Scene, name: string, input: WaterBodyProperties, definition?: WaterDefinition, customMaterial?: Material | null): Mesh {
  const body = normalizeWaterBody(input, input.kind), water = normalizeWaterDefinition(definition ?? createDefaultWaterDefinition());
  const mesh = new Mesh(name, scene);
  mesh.setEnabled(body.enabled);
  mesh.metadata = { ...(mesh.metadata ?? {}), slateWater: true };
  let plugin: WaterMaterialPlugin | null = null;
  const gridOffset = new Float64Array(2);
  // A GPU Global grid is uploaded relative to its snapped centre, which the vertex shader (built-in or a Water Waves node)
  // adds back: picks undo it, and it is zero for every surface that uploads absolute positions.
  setWaterGridOffsetSource(mesh, gridOffset);
  mesh.intersects = (ray, fastCheck, trianglePredicate, onlyBoundingInfo, worldToUse, skipBoundingInfo) =>
    intersectGridOffset(mesh, gridOffset, ray, fastCheck, trianglePredicate, onlyBoundingInfo, worldToUse, skipBoundingInfo);
  // A Custom Material with a Water Waves node displaces the rest grid on the GPU like built-in shading; any other
  // Custom Material gets displaced vertices.
  const waves = customMaterial && materialHasWaterWaves(customMaterial) ? new WaterVertexWaves(water, body) : null;
  if (customMaterial) {
    mesh.material = customMaterial;
    setMeshVertexWaves(mesh, waves);
  } else {
    const material = new PBRMaterial(`${name}:water`, scene);
    configureWaterMaterial(material, water);
    plugin = new WaterMaterialPlugin(material, water, body);
    plugin.mesh = mesh;
    plugin.gpuWaves = true;
    let reflection = reflections.get(scene);
    if (!reflection) { reflection = new WaterReflection(scene); reflections.set(scene, reflection); }
    reflection.add(material);
    mesh.material = material;
    mesh.onDisposeObservable.addOnce(() => material.dispose());
  }
  const empty = new Float32Array();
  const surface: Surface = {
    mesh, water, body, plugin, field: null, contacts: null, world: Matrix.Identity(), inverse: Matrix.Identity(), gpu: plugin !== null || waves !== null,
    waves, material: customMaterial ?? null,
    layoutState: new Float64Array(LAYOUT_STATE).fill(NaN), gridX: new Float64Array(), gridZ: new Float64Array(),
    restMin: new Vector3(), restMax: new Vector3(), shift: new Float64Array(2), gridOffset, placed: new Float64Array(16).fill(NaN), time: null, version: 0,
    qualityRevision: NaN, density: 1, drawn: true,
    base: empty, worldBase: empty, positions: empty, normals: empty, baseNormals: empty, data: empty, flow: empty, spacing: empty,
    offsets: empty, bankGradient: empty, offsetsZero: true, boundedSubMeshes: -1, boundedFirst: null, boundsDirty: false,
    copyCounted: 0, nodes: null, nodeCopyUse: 0, seenEnabled: null, uid: ++surfaceIds, blend: null, blendData: empty, blendColors: empty, blendRest: empty, blendRevision: 0,
    blendMatrix: new Float64Array(16).fill(NaN), blendEnabled: false, blendStamp: 0, blendRows: Int32Array.of(1, 0), stage: null, layoutColumns: 0, disabledSince: -1, released: false,
  };
  let entries = surfaces.get(scene);
  if (!entries) {
    entries = new Set(); surfaces.set(scene, entries);
    const observer = scene.onBeforeRenderObservable.add(() => updateSceneWater(scene));
    scene.onDisposeObservable.addOnce(() => { scene.onBeforeRenderObservable.remove(observer); surfaces.delete(scene); deleteSceneWaterClock(scene); reflections.delete(scene); });
  }
  entries.add(surface);
  surfaceByMesh.set(mesh, surface);
  // Any pass that draws the surface (views, captures, depth pre-pass) keeps its CPU work running next frame.
  mesh.onBeforeRenderObservable.add(() => { surface.drawn = true; });
  syncCopyIntent(scene, surface);
  markBlendDirty(surface);
  mesh.onDisposeObservable.addOnce(() => {
    entries.delete(surface);
    markBlendDirty(surface);
    countCopyIntent(scene, surface.copyCounted, -1);
    surface.copyCounted = 0;
  });
  refreshSurface(surface, sceneWaterTime(scene));
  if (plugin) attachFields(surface);
  else {
    surface.nodes = { water, field: null, contacts: null, partners: NO_PARTNERS };
    setMeshWaterNodeSurface(mesh, surface.nodes);
    syncNodeSurface(surface);
  }
  return mesh;
}

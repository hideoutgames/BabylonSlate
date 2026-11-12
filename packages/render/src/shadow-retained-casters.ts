import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { ThinEngine } from "@babylonjs/core/Engines/thinEngine";
import type { DataBuffer } from "@babylonjs/core/Buffers/dataBuffer";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Light } from "@babylonjs/core/Lights/light";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { DrawWrapper } from "@babylonjs/core/Materials/drawWrapper";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Material } from "@babylonjs/core/Materials/material";
import { BindSceneUniformBuffer } from "@babylonjs/core/Materials/materialHelper.functions";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import { TmpVectors, type Matrix } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";
import type { FloatArray, IndicesArray, Nullable } from "@babylonjs/core/types";
import "@babylonjs/core/Shaders/shadowMap.fragment";
import "@babylonjs/core/Shaders/shadowMap.vertex";
import { beginManagedRenderAllocation, type ManagedRenderLease } from "./managed-render-resources";
import { isAutoLodMaster } from "./model-lod";
import { retireOwnedEffect } from "./owned-effect-retirement";
import { isSmoothNormalShadowCaster } from "./shadow-bias";

/**
 * Shadow casters a map draws without Babylon's per-caster work.
 *
 * Babylon draws a caster into a map layer as it draws a mesh into a view: it rebuilds and compares the caster's
 * defines, binds its buffers, writes five uniforms and the mesh's uniform buffer, and notifies four observers, for
 * every caster, in every cascade and face, every frame the map redraws. Most casters need none of it. A rigid, opaque
 * mesh whose Material leaves its vertices where they are is drawn by the one stock depth program, and differs from the
 * next only in its world matrix and index range.
 *
 * So such casters are retained: their positions and normals live in one vertex buffer, their matrices in one data
 * texture, and a map layer draws those it lists in one `multiDrawElements` call per cull state (`CALL_DRAWS` draws a
 * call at most), each draw finding its matrix through `gl_DrawID`. Where the extension is missing the same buffer is
 * drawn one caster at a time, a uniform naming the draw. The vertex stage is Babylon's own (its normal bias and depth
 * metric chunks, its fragment shader, the generator's own defines), and the cull state and normal matrix are chosen as
 * Babylon's draw of the caster chooses them, so a retained caster writes the depth Babylon's draw of it would.
 *
 * Everything else keeps Babylon's path: skinned, morphed and cut-out casters, thin instances, levels of detail, a
 * Material with its own depth variant, and every caster on WebGPU.
 */

const VERTEX = "hapticRetainedShadow";
const SAMPLER = "hapticRetainedDraws";
const DRAW_UNIFORM = "hapticRetainedDraw";
const SLOTS_UNIFORM = "hapticRetainedSlots";
const MULTI_DRAW_DEFINE = "HAPTIC_RETAINED_MULTI_DRAW";
/** Texels a draw's row holds: its world matrix's four columns, then (has normals, uneven scaling, 0, 0). */
const TEXELS = 5;
/** Draws per row of the data texture, whose width is a whole number of them. */
const DRAWS_PER_ROW = 204;
const WIDTH = DRAWS_PER_ROW * TEXELS;
/** Draws one call lists at most: the call's slots are a uniform array, four to a vector. */
export const RETAINED_CALL_DRAWS = 256;
/** Vertices and indices the shared buffers first have room for; the room doubles as casters arrive. */
const FIRST_VERTICES = 4096;
const FIRST_INDICES = 16384;
/** Freed vertices and indices the buffers hold before they are packed, once those are also half of what they hold. */
const PACK_FLOOR = 65536;

ShaderStore.ShadersStore[`${VERTEX}VertexShader`] ??= `attribute vec3 position;
attribute vec3 normal;
#include<helperFunctions>
#include<__decl__shadowMapVertex>
#include<shadowMapVertexExtraDeclaration>
uniform highp sampler2D ${SAMPLER};
#ifdef ${MULTI_DRAW_DEFINE}
uniform ivec4 ${SLOTS_UNIFORM}[${RETAINED_CALL_DRAWS / 4}];
#else
uniform int ${DRAW_UNIFORM};
#endif
void main(void)
{
#ifdef ${MULTI_DRAW_DEFINE}
int retainedDraw=${SLOTS_UNIFORM}[gl_DrawID/4][gl_DrawID%4];
#else
int retainedDraw=${DRAW_UNIFORM};
#endif
ivec2 retainedAt=ivec2((retainedDraw%${DRAWS_PER_ROW})*${TEXELS},retainedDraw/${DRAWS_PER_ROW});
mat4 finalWorld=mat4(texelFetch(${SAMPLER},retainedAt,0),texelFetch(${SAMPLER},retainedAt+ivec2(1,0),0),texelFetch(${SAMPLER},retainedAt+ivec2(2,0),0),texelFetch(${SAMPLER},retainedAt+ivec2(3,0),0));
vec4 retainedShape=texelFetch(${SAMPLER},retainedAt+ivec2(4,0),0);
vec3 positionUpdated=position;
vec4 worldPos=finalWorld*vec4(positionUpdated,1.0);
mat3 normWorldSM=mat3(finalWorld);
if (retainedShape.y>0.5) {normWorldSM=transposeMat3(inverseMat3(normWorldSM));}
vec3 vNormalW=retainedShape.x>0.5 ? normalize(normWorldSM*normal) : vec3(0.0);
#include<shadowMapVertexNormalBias>
gl_Position=viewProjection*worldPos;
#include<shadowMapVertexMetric>
}`;

export type RetainedShadowDiagnostics = {
  casters: number; draws: number; vertices: number; indices: number; multiDraw: boolean; calls: number; drawn: number;
};

const disabledScenes = new WeakSet<Scene>();

/** Test and proof hook: whether a Scene's maps draw retained casters (on by default); off, Babylon draws every caster. */
export function setRetainedShadowCasters(scene: Scene, enabled: boolean): void {
  if (enabled) disabledScenes.delete(scene);
  else disabledScenes.add(scene);
}

/**
 * What the refresh scheduler knows of a caster: `revision` moves with anything its shadow depends on, and `safe` says
 * its mesh and Material draw what its static geometry holds (`canCacheShadowMaterial`), shown or hidden.
 */
/**
 * What the scheduler's walk found of a caster. `world` is the world matrix the walk computed, which a walked frame's
 * layers read in place of asking the mesh again (Babylon re-checks a world matrix once per render id, and every map
 * layer is one); absent where the scheduler gives none.
 */
export type RetainedCasterState = { readonly revision: number; readonly safe: boolean; readonly world?: Matrix | null };

type GeometryRange = {
  geometry: Geometry;
  /** Whether the range lists its vertices in order, for a mesh drawn without indices. */
  inOrder: boolean;
  /** The vertex buffer and index data copied: a replaced buffer is another range. They are read again when the buffers are rebuilt. */
  buffer: VertexBuffer;
  indexData: Nullable<IndicesArray>;
  positionData: FloatArray;
  normalData: Nullable<FloatArray>;
  vertexBase: number;
  vertexCount: number;
  indexBase: number;
  indexCount: number;
  users: number;
  /** Whether its geometry still maps to it. */
  mapped: boolean;
};

type Draw = { slot: number; part: SubMesh };

type Caster = {
  /** The walked frame that last asked the entry (`RetainedShadowCasters.beginFrame`), and whether its layers list it. */
  seen: number;
  listed: boolean;
  /** The scheduler's revision and the source's count of levels of detail this entry describes; -1 before the first. */
  revision: number;
  levels: number;
  /** The mesh an instance draws; null for a mesh of its own. */
  source: Mesh | null;
  /** Held while the entry has draws, and while it is parked without them (so a caster that fades keeps its geometry). */
  range: GeometryRange | null;
  draws: Draw[];
  /** The world matrix written, its update flag and the stamp it was written against (`stamp`). */
  world: unknown;
  worldFlag: number;
  stamp: number;
  /** Whether the mesh draws its vertices in order, without indices. */
  inOrder: boolean;
  /** The Material's culling bits (1: back-face culling, 4: cull back faces) and side orientation. */
  culling: number;
  side: number;
  /** Cull state bits as drawn: `culling`, and 2 for a reversed side, which a mirrored matrix turns. */
  group: number;
  uneven: boolean;
};

type Layer = {
  /** Per cull state, the slots listed. */
  slots: Int32Array[];
  counts: number[];
  planes: readonly Plane[] | null;
};

/** `vao`: the shared buffers recorded for the program; null until its next draw records the buffers there are now. */
type Program = { wrapper: DrawWrapper; effect: Effect; vao: WebGLVertexArrayObject | null };

type Gpu = {
  positions: VertexBuffer;
  normals: VertexBuffer;
  indices: DataBuffer;
  vertexCapacity: number;
  indexCapacity: number;
  lease: ManagedRenderLease;
};

type MultiDraw = { multiDrawElementsWEBGL(mode: number, counts: Int32Array, countsOffset: number, type: number, offsets: Int32Array, offsetsOffset: number, drawCount: number): void };

type GeneratorInternals = {
  _prepareShadowDefines(subMesh: unknown, useInstances: boolean, defines: string[], isTransparent: boolean): string[];
  _cachedDirection: { x: number; y: number; z: number };
  _cachedPosition: { subtractToRef(other: unknown, result: unknown): unknown };
  _getCamera(): unknown;
};

type EngineInternals = {
  bindIndexBuffer(buffer: DataBuffer | null): void;
  _resetIndexBufferBinding(): void;
  _resetVertexBufferBinding(): void;
};

const GROUPS = 8;
const NORMAL_STUB = { getMesh: () => ({ isVerticesDataPresent: () => true }) };

function grown<T extends Float32Array | Uint32Array | Int32Array>(array: T, needed: number): T {
  if (needed <= array.length) return array;
  let capacity = Math.max(array.length, 256);
  while (capacity < needed) capacity *= 2;
  const next = new (array.constructor as new (length: number) => T)(capacity);
  next.set(array);
  return next;
}

function room(needed: number, first: number): number {
  let capacity = first;
  while (capacity < needed) capacity *= 2;
  return capacity;
}

export class RetainedShadowCasters {
  private readonly scene: Scene;
  private readonly engine: ThinEngine;
  private readonly state: (mesh: AbstractMesh) => RetainedCasterState | undefined;
  /** The extension that draws a layer's casters in one call; null where it is missing or its program failed. */
  private multiDraw: MultiDraw | null;
  private readonly casters = new Map<AbstractMesh, Caster>();
  /** Indexed geometries' ranges, and those of geometries a mesh draws without indices (its vertices in order). */
  private readonly geometries = new Map<Geometry, GeometryRange>();
  private readonly unindexed = new Map<Geometry, GeometryRange>();
  /** Every range a caster uses, in buffer order. */
  private readonly live = new Set<GeometryRange>();
  /** Vertices and indices the buffers hold, those of freed ranges among them (`wasted`). */
  private vertices = 0;
  private indexCount = 0;
  private wasted = 0;
  private gpu: Gpu | null = null;
  private scratch = new Uint32Array(0);
  /** Per slot: its draw's index count and its byte offset in the indices. */
  private counted = new Int32Array(0);
  private offsets = new Int32Array(0);
  private slotCount = 0;
  private readonly freeSlots: number[] = [];
  /** One call's draws: their slots (the uniform array), index counts and byte offsets. */
  private readonly callSlots = new Int32Array(RETAINED_CALL_DRAWS);
  private readonly callCounts = new Int32Array(RETAINED_CALL_DRAWS);
  private readonly callOffsets = new Int32Array(RETAINED_CALL_DRAWS);
  private rows = new Float32Array(0);
  /** The texture rows written since the last upload; none while `dirtyTo` is below `dirtyFrom`. */
  private dirtyFrom = Infinity;
  private dirtyTo = -1;
  /**
   * The floating origin and handedness the rows are written against, and a stamp that moves with either: a row written
   * against another stamp is written again.
   */
  private originX = 0;
  private originY = 0;
  private originZ = 0;
  private rightHanded = false;
  private stamp = 0;
  private texture: RawTexture | null = null;
  private textureRows = 0;
  private textureLease: ManagedRenderLease | undefined;
  private readonly programs = new Map<string, Program>();
  private readonly layers = new WeakMap<ShadowGenerator, Layer>();
  private current: Layer | null = null;
  /** The walked frame whose layers share what they find of a caster (`beginFrame`); 0 outside one. */
  private frame = 0;
  private frames = 0;
  private sceneFrame = -1;
  private readonly frameEnd: Nullable<Observer<Scene>>;
  private refused = false;
  private disposed = false;
  private readonly restored: Nullable<Observer<AbstractEngine>>;
  /** Draw calls made, and the caster draws they stood for. */
  private calls = 0;
  private drawn = 0;

  /** Null where retained draws cannot work: WebGPU (Babylon's path stays), or an engine without WebGL2. */
  static create(scene: Scene, state: (mesh: AbstractMesh) => RetainedCasterState | undefined): RetainedShadowCasters | null {
    const engine = scene.getEngine() as ThinEngine;
    if (engine.isWebGPU || engine.webGLVersion < 2 || !engine._gl) return null;
    return new RetainedShadowCasters(scene, state);
  }

  private constructor(scene: Scene, state: (mesh: AbstractMesh) => RetainedCasterState | undefined) {
    this.scene = scene;
    this.engine = scene.getEngine() as ThinEngine;
    this.state = state;
    this.multiDraw = (this.engine._gl.getExtension("WEBGL_multi_draw") as MultiDraw | null) ?? null;
    this.frameEnd = scene.onAfterRenderObservable.add(() => { this.frame = 0; });
    // A restored context has none of the old one's buffers: they are built again from what the casters hold.
    this.restored = this.engine.onContextRestoredObservable.add(() => {
      this.multiDraw = (this.engine._gl.getExtension("WEBGL_multi_draw") as MultiDraw | null) ?? null;
      this.forgetGpu(false);
    });
  }

  /**
   * Starts listing a map layer's casters, culled by `planes` (null: nothing to cull a mesh's parts by). False when
   * the layer draws none retained now: Babylon then draws every caster as before.
   */
  begin(generator: ShadowGenerator, planes: readonly Plane[] | null): boolean {
    this.discard(generator);
    const scene = this.scene;
    // A forced fill mode and a clip plane change every caster's draw: Babylon's own path applies them.
    if (this.disposed || this.refused || disabledScenes.has(scene) || scene.forceWireframe || scene.forcePointsCloud || scene.clipPlane ||
      scene.clipPlane2 || scene.clipPlane3 || scene.clipPlane4 || scene.clipPlane5 || scene.clipPlane6) return false;
    const program = this.programFor(generator);
    if (!program?.effect.isReady()) return false;
    // Under a floating origin Babylon uploads a world matrix less the eye's position: every row follows the eye.
    const origin = scene.floatingOriginOffset;
    if (origin.x !== this.originX || origin.y !== this.originY || origin.z !== this.originZ || scene.useRightHandedSystem !== this.rightHanded) {
      this.originX = origin.x; this.originY = origin.y; this.originZ = origin.z;
      this.rightHanded = scene.useRightHandedSystem;
      this.stamp += 1;
    }
    let layer = this.layers.get(generator);
    if (!layer) this.layers.set(generator, (layer = { slots: Array.from({ length: GROUPS }, () => new Int32Array(0)), counts: new Array<number>(GROUPS).fill(0), planes: null }));
    layer.planes = planes;
    this.current = layer;
    return true;
  }

  /**
   * The Scene's casters were just walked for a frame (`ShadowMapRefresh.syncCasters`): until that frame ends, nothing
   * moves, shows, hides or changes one, so each is described, and its world matrix read, by the first layer that lists
   * it and not again by the frame's other layers. A pass outside such a frame (a readiness probe, a warm-up draw) asks
   * every caster itself.
   */
  beginFrame(): void {
    this.frame = ++this.frames;
    this.sceneFrame = this.scene.getFrameId();
  }

  /** Forgets what `generator`'s layer listed and has not drawn: a pass that lists nothing draws nothing retained. */
  discard(generator: ShadowGenerator): void {
    this.current = null;
    this.layers.get(generator)?.counts.fill(0);
  }

  /** Lists `mesh` in the layer begun. True when its draws are retained: Babylon must leave it out of its own list. */
  take(mesh: AbstractMesh): boolean {
    const layer = this.current;
    if (!layer) return false;
    // A frame's layers ask the same casters: what the first found of one holds for the others (`beginFrame`).
    const frame = this.frame && this.scene.getFrameId() === this.sceneFrame ? this.frame : 0;
    let caster = frame ? this.casters.get(mesh) ?? null : null;
    if (!caster || caster.seen !== frame || (caster.listed && caster.stamp !== this.stamp)) {
      caster = this.describe(mesh);
      // Babylon's own list draws nothing of a hidden mesh: left in it, the mesh stays undrawn.
      const listed = !!caster && mesh.isEnabled() && mesh.isVisible && !mesh.isBlocked;
      if (listed) {
        const world = (frame ? this.state(mesh)?.world : null) ?? mesh.getWorldMatrix();
        if (world !== caster!.world || world.updateFlag !== caster!.worldFlag || caster!.stamp !== this.stamp || this.unevenFor(mesh, caster!) !== caster!.uneven)
          this.writeWorld(mesh, caster!, world);
      }
      // A caster that cannot be retained keeps its entry, without draws.
      const entry = caster ?? this.casters.get(mesh);
      if (entry) {
        entry.seen = frame;
        entry.listed = listed;
      }
      if (!listed) return false;
    } else if (!caster.listed) return false;
    caster = caster!;
    const group = caster.group;
    // A mesh of several parts leaves out those outside the map; an instance's parts carry its source's boxes.
    const planes = caster.draws.length > 1 && !caster.source ? layer.planes : null;
    for (const draw of caster.draws) {
      if (planes && outside(draw.part, planes)) continue;
      let slots = layer.slots[group]!;
      const count = layer.counts[group]!;
      if (count >= slots.length) slots = layer.slots[group] = grown(slots, count + 1);
      slots[count] = draw.slot;
      layer.counts[group] = count + 1;
    }
    return true;
  }

  /** Draws the casters `generator`'s layer listed since its last `begin`, into the target and view bound now. */
  draw(generator: ShadowGenerator): void {
    const layer = this.layers.get(generator);
    if (!layer || this.disposed) return;
    let listed = 0;
    for (let group = 0; group < GROUPS; group += 1) listed += layer.counts[group]!;
    if (!listed) return;
    const program = this.programFor(generator);
    const gpu = this.gpu, texture = this.texture;
    if (!program?.effect.isReady() || !gpu || !texture) {
      layer.counts.fill(0);
      return;
    }
    const engine = this.engine, gl = engine._gl, scene = this.scene, effect = program.effect;
    program.vao ??= engine.recordVertexArrayObject({ [VertexBuffer.PositionKind]: gpu.positions, [VertexBuffer.NormalKind]: gpu.normals }, gpu.indices, effect);
    if (this.dirtyTo >= this.dirtyFrom) {
      const from = this.dirtyFrom, count = Math.min(this.dirtyTo, this.textureRows - 1) - from + 1;
      if (count > 0) engine.updateTextureData(texture.getInternalTexture()!, this.rows.subarray(from * WIDTH * 4, (from + count) * WIDTH * 4), 0, from, WIDTH, count);
      this.dirtyFrom = Infinity;
      this.dirtyTo = -1;
    }
    const internals = generator as unknown as GeneratorInternals;
    engine.enableEffect(program.wrapper);
    // The uniforms Babylon's own draw of a caster sets (`ShadowGenerator._renderSubMeshForShadowMap`).
    generator.getTransformMatrix();
    effect.setFloat3("biasAndScaleSM", generator.bias, generator.normalBias, generator.depthScale);
    const light = generator.getLight();
    if (light.getTypeID() === Light.LIGHTTYPEID_DIRECTIONALLIGHT) effect.setVector3("lightDataSM", internals._cachedDirection as never);
    else effect.setVector3("lightDataSM", internals._cachedPosition.subtractToRef(scene.floatingOriginOffset, TmpVectors.Vector3[0]) as never);
    const camera = internals._getCamera() as never;
    effect.setFloat2("depthValuesSM", light.getDepthMinZ(camera), light.getDepthMinZ(camera) + light.getDepthMaxZ(camera));
    if (!engine.supportsUniformBuffers) effect.setMatrix("viewProjection", scene.getTransformMatrix());
    const sceneBuffer = scene.getSceneUniformBuffer();
    BindSceneUniformBuffer(effect, sceneBuffer);
    sceneBuffer.bindUniformBuffer();
    effect.setTexture(SAMPLER, texture);
    engine.bindVertexArrayObject(program.vao, gpu.indices);
    const counted = this.counted, offsets = this.offsets;
    let indices = 0;
    for (let group = 0; group < GROUPS; group += 1) {
      const count = layer.counts[group]!;
      if (!count) continue;
      const slots = layer.slots[group]!;
      // As Babylon's draw: the Material's culling, its side turned for a mirrored mesh, or back faces alone.
      const cullBackFaces = (group & 4) !== 0;
      if (generator.forceBackFacesOnly) engine.setState(true, 0, false, true, cullBackFaces);
      else engine.setState((group & 1) !== 0, 0, false, (group & 2) !== 0, cullBackFaces);
      engine.applyStates();
      if (this.multiDraw) {
        const callSlots = this.callSlots, callCounts = this.callCounts, callOffsets = this.callOffsets;
        for (let from = 0; from < count; from += RETAINED_CALL_DRAWS) {
          const draws = Math.min(RETAINED_CALL_DRAWS, count - from);
          for (let index = 0; index < draws; index += 1) {
            const slot = slots[from + index]!;
            callSlots[index] = slot;
            callCounts[index] = counted[slot]!;
            callOffsets[index] = offsets[slot]!;
            indices += counted[slot]!;
          }
          effect.setIntArray4(SLOTS_UNIFORM, callSlots);
          this.multiDraw.multiDrawElementsWEBGL(gl.TRIANGLES, callCounts, 0, gl.UNSIGNED_INT, callOffsets, 0, draws);
          engine._drawCalls.addCount(1, false);
          this.calls += 1;
        }
      } else {
        for (let index = 0; index < count; index += 1) {
          const slot = slots[index]!;
          effect.setInt(DRAW_UNIFORM, slot);
          gl.drawElements(gl.TRIANGLES, counted[slot]!, gl.UNSIGNED_INT, offsets[slot]!);
          indices += counted[slot]!;
        }
        engine._drawCalls.addCount(count, false);
        this.calls += count;
      }
      this.drawn += count;
    }
    // Babylon counts a draw's indices; the maps' triangle count reads them.
    scene._activeIndices.addCount(indices, false);
    layer.counts.fill(0);
  }

  /** Forgets a caster that left the Scene's shadows. */
  release(mesh: AbstractMesh): void {
    const caster = this.casters.get(mesh);
    if (!caster) return;
    this.casters.delete(mesh);
    this.freeDraws(caster);
    if (caster.range) this.leave(caster.range);
    caster.range = null;
  }

  /**
   * The casters retained and their draws, the vertices and indices the shared buffers hold, whether a layer draws in
   * one call, and, since the Scene's first map, the draw calls made and the caster draws they stood for.
   */
  diagnostics(): RetainedShadowDiagnostics {
    let casters = 0, draws = 0;
    for (const caster of this.casters.values()) if (caster.draws.length) { casters += 1; draws += caster.draws.length; }
    return { casters, draws, vertices: this.vertices, indices: this.indexCount, multiDraw: this.multiDraw !== null, calls: this.calls, drawn: this.drawn };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current = null;
    this.engine.onContextRestoredObservable.remove(this.restored);
    this.scene.onAfterRenderObservable.remove(this.frameEnd);
    this.casters.clear();
    this.geometries.clear();
    this.unindexed.clear();
    this.live.clear();
    this.forgetGpu(true);
    for (const program of this.programs.values()) retireOwnedEffect(program.effect, () => program.wrapper.dispose());
    this.programs.clear();
  }

  /**
   * `mesh`'s entry when its draws can be retained, described again only when the scheduler saw it change. Retained:
   * a rigid mesh, or an instance of one, with static geometry held on the CPU, one opaque Material with the stock
   * vertex stage (the scheduler's safe caster), triangles, no levels of detail and the map's own normal bias.
   */
  private describe(mesh: AbstractMesh): Caster | null {
    const state = this.state(mesh);
    if (!state) return null;
    const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
    // Levels of detail can arrive without the scheduler's revision moving (an automatic level mirrors its master).
    const levels = source instanceof Mesh ? source.getLODLevels().length : 0;
    let caster = this.casters.get(mesh);
    if (caster && caster.revision === state.revision && caster.levels === levels) return caster.draws.length ? caster : null;
    if (!caster) {
      caster = {
        seen: 0, listed: false, revision: -1, levels: 0, source: null, range: null, draws: [], world: null, worldFlag: -1, stamp: -1, inOrder: false, culling: 0, side: 0,
        group: 0, uneven: false,
      };
      this.casters.set(mesh, caster);
    }
    caster.revision = state.revision;
    caster.levels = levels;
    const geometry = source instanceof Mesh ? source.geometry : null;
    const material = mesh.material ?? this.scene.defaultMaterial;
    const parts = source.subMeshes;
    const retainable = state.safe && source instanceof Mesh && !!geometry && !!parts?.length && !levels && !isAutoLodMaster(source) &&
      !source.hasThinInstances && source.overrideRenderingFillMode === null &&
      material.fillMode === Material.TriangleFillMode && !isSmoothNormalShadowCaster(mesh) && !isSmoothNormalShadowCaster(source);
    const inOrder = retainable && (source as Mesh).isUnIndexed;
    const range = retainable ? this.rangeFor(geometry, inOrder) : null;
    if (!range) {
      // Parked: without draws, and with the range it had, which a caster that only fades soon uses again. A range its
      // geometry has left is freed.
      this.freeDraws(caster);
      if (caster.range && !caster.range.mapped) {
        this.leave(caster.range);
        caster.range = null;
      }
      return null;
    }
    // The same geometry and parts keep their slots; only the matrix and the cull state are written again.
    const same = caster.range === range && caster.draws.length === parts!.length && caster.draws.every((draw, index) =>
      draw.part === parts![index] && this.counted[draw.slot] === partCount(parts![index]!, inOrder) &&
      this.offsets[draw.slot] === (range.indexBase + partStart(parts![index]!, inOrder)) * 4);
    if (!same) {
      this.freeDraws(caster);
      const previous = caster.range;
      range.users += 1;
      caster.range = range;
      if (previous) this.leave(previous);
      for (const part of parts!) {
        const start = partStart(part, inOrder), count = partCount(part, inOrder);
        // A part that is not whole triangles of its geometry is left to Babylon, and the mesh with it: so is a mesh
        // the draws' data texture has no room for.
        const slot = start < 0 || count <= 0 || count % 3 !== 0 || start + count > range.indexCount ? -1 : this.slot();
        if (slot < 0) {
          this.freeDraws(caster);
          return null;
        }
        this.counted[slot] = count;
        this.offsets[slot] = (range.indexBase + start) * 4;
        caster.draws.push({ slot, part });
      }
      caster.inOrder = inOrder;
    }
    caster.source = source === mesh ? null : source as Mesh;
    caster.culling = (material.backFaceCulling ? 1 : 0) | (material.cullBackFaces ? 4 : 0);
    caster.side = material._getEffectiveOrientation(source as Mesh);
    caster.world = null;
    return caster;
  }

  private freeDraws(caster: Caster): void {
    for (const draw of caster.draws) {
      this.counted[draw.slot] = 0;
      this.freeSlots.push(draw.slot);
    }
    caster.draws.length = 0;
  }

  /** One caster fewer uses `range`; unused, its place in the buffers is freed. */
  private leave(range: GeometryRange): void {
    range.users -= 1;
    if (range.users <= 0) this.retire(range);
  }

  private retire(range: GeometryRange): void {
    if (range.mapped) {
      (range.inOrder ? this.unindexed : this.geometries).delete(range.geometry);
      range.mapped = false;
    }
    if (this.live.delete(range)) this.wasted += range.vertexCount + range.indexCount;
  }

  /** A free row of the data texture, or -1 when the rendering budget has no room for another. */
  private slot(): number {
    const free = this.freeSlots.pop();
    if (free !== undefined) return free;
    if (!this.reserveRows(Math.ceil((this.slotCount + 1) / DRAWS_PER_ROW))) return -1;
    const slot = this.slotCount++;
    this.counted = grown(this.counted, this.slotCount);
    this.offsets = grown(this.offsets, this.slotCount);
    return slot;
  }

  /** Makes the data texture hold `rows` rows of draws; false when the rendering budget has no room for it. */
  private reserveRows(rows: number): boolean {
    if (this.texture && this.textureRows >= rows) return true;
    let capacity = Math.max(this.textureRows, 4);
    while (capacity < rows) capacity *= 2;
    const lease = beginManagedRenderAllocation(this.engine, WIDTH * capacity * 16);
    if (!lease) return false;
    const data = new Float32Array(WIDTH * capacity * 4);
    data.set(this.rows.length > data.length ? this.rows.subarray(0, data.length) : this.rows);
    // On the Engine, not the Scene: a texture a Scene lists asks each of its views for a readiness probe.
    const texture = new RawTexture(data, WIDTH, capacity, Constants.TEXTUREFORMAT_RGBA, this.engine, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
    texture.name = "hapticRetainedShadowDraws";
    lease.commit([{ handle: texture.getInternalTexture()!, bytes: WIDTH * capacity * 16, category: "geometry" }]);
    this.texture?.dispose();
    this.textureLease?.release();
    this.texture = texture;
    this.textureLease = lease;
    this.textureRows = capacity;
    this.rows = data;
    // The new texture was created with every row.
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
    return true;
  }

  /**
   * `geometry`'s place in the shared buffers, copied in on first use; null when its data cannot be retained or the
   * rendering budget has no room for it. `inOrder`: for a mesh that draws its vertices in order, the indices are theirs
   * in turn.
   */
  private rangeFor(geometry: Geometry, inOrder: boolean): GeometryRange | null {
    const ranges = inOrder ? this.unindexed : this.geometries;
    const buffer = geometry.getVertexBuffer(VertexBuffer.PositionKind);
    const indexData = inOrder ? null : geometry.getIndices();
    const held = ranges.get(geometry);
    if (held && held.buffer === buffer && held.indexData === indexData) return held;
    if (held) {
      // Replaced data: the casters that use the old range describe themselves again when the scheduler says so.
      ranges.delete(geometry);
      held.mapped = false;
      if (held.users <= 0) this.retire(held);
    }
    if (!buffer || buffer.isUpdatable() || (!inOrder && !indexData?.length)) return null;
    const normalBuffer = geometry.getVertexBuffer(VertexBuffer.NormalKind);
    if (normalBuffer?.isUpdatable()) return null;
    const positionData = geometry.getVerticesData(VertexBuffer.PositionKind);
    if (!positionData) return null;
    const normalData = normalBuffer ? geometry.getVerticesData(VertexBuffer.NormalKind) : null;
    const vertexCount = Math.floor(positionData.length / 3);
    if (!vertexCount || (normalData && normalData.length < vertexCount * 3)) return null;
    const indexCount = indexData ? indexData.length : vertexCount;
    if (indexData) for (let index = 0; index < indexCount; index += 1) if (indexData[index]! >= vertexCount) return null;
    if (this.wasted > PACK_FLOOR && this.wasted > (this.vertices + this.indexCount) / 2) this.pack();
    const vertices = this.vertices + vertexCount, indices = this.indexCount + indexCount;
    if ((!this.gpu || vertices > this.gpu.vertexCapacity || indices > this.gpu.indexCapacity) &&
      !this.allocate(room(vertices, FIRST_VERTICES), room(indices, FIRST_INDICES))) return null;
    const range: GeometryRange = {
      geometry, inOrder, buffer, indexData, positionData, normalData, vertexBase: this.vertices, vertexCount, indexBase: this.indexCount, indexCount,
      users: 0, mapped: true,
    };
    this.vertices = vertices;
    this.indexCount = indices;
    this.live.add(range);
    ranges.set(geometry, range);
    this.write(range);
    return range;
  }

  /** Moves the ranges still used to the buffers' start, and their casters' draws with them. */
  private pack(): void {
    let vertices = 0, indices = 0;
    for (const range of this.live) {
      range.vertexBase = vertices;
      range.indexBase = indices;
      vertices += range.vertexCount;
      indices += range.indexCount;
    }
    this.vertices = vertices;
    this.indexCount = indices;
    this.wasted = 0;
    for (const caster of this.casters.values()) {
      const range = caster.range;
      if (range) for (const draw of caster.draws) this.offsets[draw.slot] = (range.indexBase + partStart(draw.part, caster.inOrder)) * 4;
    }
    const gpu = this.gpu;
    if (!gpu) return;
    // Smaller buffers when the ranges fit them; where the budget refuses, the ranges are written again in the ones held.
    const vertexCapacity = room(vertices, FIRST_VERTICES), indexCapacity = room(indices, FIRST_INDICES);
    if ((vertexCapacity !== gpu.vertexCapacity || indexCapacity !== gpu.indexCapacity) && this.allocate(vertexCapacity, indexCapacity)) return;
    for (const range of this.live) this.write(range);
  }

  /** Replaces the shared buffers with ones of this room and writes every range into them; false when there is no room. */
  private allocate(vertexCapacity: number, indexCapacity: number): boolean {
    const engine = this.engine;
    const lease = beginManagedRenderAllocation(engine, vertexCapacity * 24 + indexCapacity * 4);
    if (!lease) return false;
    let positions: DataBuffer | null = null, normals: DataBuffer | null = null, indices: DataBuffer | null = null;
    try {
      positions = engine.createDynamicVertexBuffer(vertexCapacity * 12);
      normals = engine.createDynamicVertexBuffer(vertexCapacity * 12);
      indices = engine.createIndexBuffer(new Uint32Array(indexCapacity), true, "hapticRetainedShadowIndices");
    } catch {
      for (const buffer of [positions, normals, indices]) if (buffer) engine._releaseBuffer(buffer);
      lease.release();
      return false;
    }
    lease.commit([
      { handle: positions, bytes: vertexCapacity * 12, category: "geometry" },
      { handle: normals, bytes: vertexCapacity * 12, category: "geometry" },
      { handle: indices, bytes: indexCapacity * 4, category: "geometry" },
    ]);
    this.releaseBuffers(true);
    this.gpu = {
      positions: new VertexBuffer(engine, positions, VertexBuffer.PositionKind, true, false, 3),
      normals: new VertexBuffer(engine, normals, VertexBuffer.NormalKind, true, false, 3),
      indices, vertexCapacity, indexCapacity, lease,
    };
    for (const range of this.live) this.write(range);
    return true;
  }

  /** Writes `range`'s vertices and indices into the shared buffers, from the data its geometry holds. */
  private write(range: GeometryRange): void {
    const gpu = this.gpu;
    if (!gpu) return;
    const engine = this.engine, gl = engine._gl, internals = engine as unknown as EngineInternals;
    const floats = range.vertexCount * 3;
    const positions = range.positionData instanceof Float32Array ? range.positionData : new Float32Array(range.positionData);
    // A mesh without normals reads zeros: its row says so, and no bias moves it.
    const normals = !range.normalData ? new Float32Array(floats) : range.normalData instanceof Float32Array ? range.normalData : new Float32Array(range.normalData);
    engine.bindArrayBuffer(gpu.positions.getBuffer());
    gl.bufferSubData(gl.ARRAY_BUFFER, range.vertexBase * 12, positions, 0, floats);
    engine.bindArrayBuffer(gpu.normals.getBuffer());
    gl.bufferSubData(gl.ARRAY_BUFFER, range.vertexBase * 12, normals, 0, floats);
    internals._resetVertexBufferBinding();
    const scratch = this.scratch = grown(this.scratch, range.indexCount);
    const indexData = range.indexData, base = range.vertexBase;
    for (let index = 0; index < range.indexCount; index += 1) scratch[index] = (indexData ? indexData[index]! : index) + base;
    internals.bindIndexBuffer(gpu.indices);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, range.indexBase * 4, scratch, 0, range.indexCount);
    internals._resetIndexBufferBinding();
  }

  /** Whether Babylon's draw of `mesh` takes its normals through the inverse transpose of its matrix. */
  private unevenFor(mesh: AbstractMesh, caster: Caster): boolean {
    const source = caster.source;
    // Babylon draws an instance in its source's batch, with the source's defines, unless one of the two is mirrored
    // and the other is not: it then draws the instance as a mesh of its own.
    if (source && (source._getWorldMatrixDeterminant() < 0) === (mesh._getWorldMatrixDeterminant() < 0)) return source.nonUniformScaling;
    return mesh.nonUniformScaling;
  }

  /** Writes `mesh`'s world matrix and shape into its draws' rows. */
  private writeWorld(mesh: AbstractMesh, caster: Caster, world: Matrix): void {
    caster.world = world;
    caster.worldFlag = world.updateFlag;
    caster.stamp = this.stamp;
    // Babylon's shadow draw turns the Material's side for a mirrored mesh; a right-handed Scene turns it once more.
    const mirrored = mesh._getWorldMatrixDeterminant() < 0;
    const side = mirrored !== this.rightHanded ? (caster.side === 0 ? 1 : 0) : caster.side;
    caster.group = caster.culling | (side === 0 ? 2 : 0);
    caster.uneven = this.unevenFor(mesh, caster);
    const normals = caster.range!.normalData ? 1 : 0, uneven = caster.uneven ? 1 : 0;
    const m = world.m, rows = this.rows;
    for (const draw of caster.draws) {
      const at = draw.slot * TEXELS * 4;
      rows.set(m, at);
      // Subtracted before the value narrows to 32 bits, as Babylon's own upload of a world matrix does.
      rows[at + 12] = m[12]! - this.originX;
      rows[at + 13] = m[13]! - this.originY;
      rows[at + 14] = m[14]! - this.originZ;
      rows[at + 16] = normals;
      rows[at + 17] = uneven;
      rows[at + 18] = 0;
      rows[at + 19] = 0;
      const row = Math.floor(draw.slot / DRAWS_PER_ROW);
      if (row < this.dirtyFrom) this.dirtyFrom = row;
      if (row > this.dirtyTo) this.dirtyTo = row;
    }
  }

  /** The depth program for `generator`'s defines; null when it failed. */
  private programFor(generator: ShadowGenerator): Program | null {
    const defines: string[] = [];
    (generator as unknown as GeneratorInternals)._prepareShadowDefines(NORMAL_STUB, false, defines, false);
    if (this.multiDraw) defines.unshift("#extension GL_ANGLE_multi_draw : require", `#define ${MULTI_DRAW_DEFINE}`);
    const key = defines.join("\n");
    let program = this.programs.get(key);
    if (!program) {
      const effect = this.engine.createEffect({ vertex: VERTEX, fragment: "shadowMap" }, {
        attributes: [VertexBuffer.PositionKind, VertexBuffer.NormalKind],
        uniformsNames: ["viewProjection", "lightDataSM", "depthValuesSM", "biasAndScaleSM", DRAW_UNIFORM, SLOTS_UNIFORM],
        uniformBuffersNames: ["Scene", "Mesh"],
        samplers: [SAMPLER],
        defines: key,
        fallbacks: null,
        onCompiled: null,
        onError: (_effect, errors) => {
          // Without `gl_DrawID` the same buffer still draws, a caster at a time; without that, Babylon's path does.
          if (this.multiDraw) this.multiDraw = null;
          else this.refused = true;
          console.warn(`[render] Retained shadow casters ${this.refused ? "are off" : "draw one at a time"}: their program failed to compile: ${errors}`);
        },
      }, this.engine);
      const wrapper = new DrawWrapper(this.engine);
      wrapper.setEffect(effect, key);
      program = { wrapper, effect, vao: null };
      this.programs.set(key, program);
    }
    return this.refused ? null : program;
  }

  /**
   * Drops the buffers, the vertex arrays and the data texture. `release`: delete them too; a restored context has
   * already lost them. What the casters hold stays: the next caster described builds the buffers again.
   */
  private forgetGpu(release: boolean): void {
    this.releaseBuffers(release);
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
      this.textureLease?.release();
      this.textureLease = undefined;
      this.textureRows = 0;
    }
    if (this.disposed) return;
    this.frame = 0;
    // Every caster describes itself again, into buffers and a texture built for the context there is now.
    for (const caster of this.casters.values()) {
      caster.draws.length = 0;
      caster.range = null;
      caster.revision = -1;
    }
    this.geometries.clear();
    this.unindexed.clear();
    this.live.clear();
    this.vertices = this.indexCount = this.wasted = 0;
    this.slotCount = 0;
    this.freeSlots.length = 0;
    this.counted.fill(0);
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
    this.current = null;
  }

  private releaseBuffers(release: boolean): void {
    for (const program of this.programs.values()) {
      if (program.vao && release) this.engine.releaseVertexArrayObject(program.vao);
      program.vao = null;
    }
    const gpu = this.gpu;
    if (!gpu) return;
    this.gpu = null;
    if (release) {
      gpu.positions.dispose();
      gpu.normals.dispose();
      this.engine._releaseBuffer(gpu.indices);
    }
    gpu.lease.release();
  }
}

/** Where a part's draw starts and how much it draws: its indices, or its vertices for a mesh drawn in order. */
const partStart = (part: SubMesh, inOrder: boolean) => inOrder ? part.verticesStart : part.indexStart;
const partCount = (part: SubMesh, inOrder: boolean) => inOrder ? part.verticesCount : part.indexCount;

/** Whether `part`'s box lies wholly outside one of `planes`: the test a map applies to a mesh's parts. */
function outside(part: SubMesh, planes: readonly Plane[]): boolean {
  const box = part.getBoundingInfo()?.boundingBox;
  if (!box) return false;
  for (const plane of planes) {
    const n = plane.normal;
    if (n.x * (n.x >= 0 ? box.maximumWorld.x : box.minimumWorld.x) + n.y * (n.y >= 0 ? box.maximumWorld.y : box.minimumWorld.y) +
      n.z * (n.z >= 0 ? box.maximumWorld.z : box.minimumWorld.z) + plane.d < 0) return true;
  }
  return false;
}

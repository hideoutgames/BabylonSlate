import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/culling/cullObjectsTask";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Node } from "@babylonjs/core/node";
import type { IParticleSystem } from "@babylonjs/core/Particles/IParticleSystem";
import { RenderingManager } from "@babylonjs/core/Rendering/renderingManager";
import type { Scene } from "@babylonjs/core/scene";
import {
  DEFAULT_DECAL_PROPERTIES,
  normalizeDecalBlendMode,
  type DecalBinding,
  type DecalBlendMode,
  type DecalProperties,
  type DynamicDecalSpawnRequest,
} from "@haptic/core";
import { DECAL_SHADER_NAME, registerDecalShaders } from "./decal-shader";
import {
  HAPTIC_LIGHTING_SAMPLERS,
  HAPTIC_LIGHTING_UNIFORMS,
  bindHapticLightingUniforms,
} from "./haptic-lighting-block";
import { sceneRenderingSettings } from "./render-settings";
import { bindSceneFog, bindSceneFogColor } from "./scene-fog-block";
import { ManagedShadowObjectRendererTask } from "./framegraph-managed-shadows";

export type DecalTextureResolver = (guid: string) => BaseTexture | null;

type PreparedDecal = {
  world: Matrix;
  inverseWorld: Matrix;
  center: Vector3;
  radius: number;
  properties: DecalProperties;
  opacityMultiplier: number;
};

type AuthoredDecalEntry = PreparedDecal & {
  id: string;
  local: Matrix;
  bounds: BoundingInfo;
  valid: boolean;
};

type DynamicDecalEntry = PreparedDecal & {
  alive: boolean;
  age: number;
  lifetime: number;
  fadeOutDuration: number;
};

type DecalBatch = {
  key: string;
  sortOrder: number;
  blendMode: DecalBlendMode;
  receiveLighting: boolean;
  textureGuid: string;
  normalTextureGuid: string | null;
  items: PreparedDecal[];
};

export interface SceneDecalStats {
  authored: number;
  dynamic: number;
  visible: number;
  batches: number;
  draws: number;
  capacity: number;
}

const DECAL_ATTRIBUTES = [
  "position",
  "world0",
  "world1",
  "world2",
  "world3",
  "decalInv0",
  "decalInv1",
  "decalInv2",
  "decalInv3",
  "decalTintOpacity",
  "decalParams",
];

const DECAL_BASE_UNIFORMS = [
  "viewProjection",
  "invViewProjection",
  "view",
  "invViewport",
  "depthRange",
  "reverseDepth",
  "cameraPosition",
  "sceneLinear",
  "blendModeId",
  "sceneFogInfo",
  "sceneFogColor",
];

function encloseDecal(entry: AuthoredDecalEntry, world: Matrix): void {
  const center = entry.center.copyFromFloats(world.m[12]!, world.m[13]!, world.m[14]!);
  let farthest = 0;
  for (const corner of entry.bounds.boundingBox.vectorsWorld) {
    farthest = Math.max(farthest, Vector3.DistanceSquared(corner, center));
  }
  entry.radius = Math.sqrt(farthest);
}

function sphereFrustumSide(planes: readonly Plane[], center: Vector3, radius: number): -1 | 0 | 1 {
  const reach = radius + radius * 1e-6 + 1e-4;
  let inside = true;
  for (let index = 0; index < planes.length; index++) {
    const distance = planes[index]!.dotCoordinate(center);
    if (distance < -reach) return -1;
    if (!(distance >= reach)) inside = false;
  }
  return inside ? 1 : 0;
}

function blendModeId(mode: DecalBlendMode): number {
  return mode === "additive" ? 2 : mode === "multiply" ? 1 : 0;
}

function babylonAlphaMode(mode: DecalBlendMode): number {
  return mode === "additive"
    ? Constants.ALPHA_ADD
    : mode === "multiply"
      ? Constants.ALPHA_MULTIPLY
      : Constants.ALPHA_COMBINE;
}

/** Capacity of the dynamic runtime decal ring buffer, scaled by quality tier. */
export function maxDynamicDecalsForScene(scene: Scene): number {
  return sceneRenderingSettings(scene).lodDistanceScale <= 1.25 ? 64 : 128;
}

class DecalActorOwner {
  readonly decals: AuthoredDecalEntry[] = [];
  readonly scene: Scene;
  readonly actorId: string;
  readonly node: TransformNode;
  visible = true;
  admitted = true;
  private readonly rootWorld = Matrix.Identity();
  private readonly world = Matrix.Identity();
  private readonly part = Matrix.Identity();
  private signature = "";
  private dirty = true;
  private readonly disposed: Observer<Node>;

  constructor(scene: Scene, actorId: string, node: TransformNode) {
    this.scene = scene;
    this.actorId = actorId;
    this.node = node;
    this.disposed = node.onDisposeObservable.add(() => removeDecals(scene, actorId));
  }

  update(bindings: readonly DecalBinding[]): boolean {
    const signature = JSON.stringify(bindings);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.decals.length = 0;
    for (const binding of bindings) {
      const properties = binding.properties;
      if (binding.error || !properties.enabled || !properties.textureGuid || properties.opacity <= 0) continue;
      // Unit cube spans [-0.5, 0.5]^3 so scaling by size maps it directly to the OBB.
      const local = Matrix.Scaling(properties.size[0], properties.size[1], properties.size[2]);
      for (const transform of binding.transforms) {
        Matrix.ComposeToRef(
          Vector3.FromArray(transform.scale),
          Quaternion.FromArray(transform.rotation),
          Vector3.FromArray(transform.position),
          this.part,
        );
        local.multiplyToRef(this.part, local);
      }
      this.decals.push({
        id: binding.id,
        properties,
        opacityMultiplier: 1,
        local,
        world: Matrix.Identity(),
        inverseWorld: Matrix.Identity(),
        bounds: new BoundingInfo(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5)),
        center: Vector3.Zero(),
        radius: 0,
        valid: false,
      });
    }
    this.dirty = true;
    return true;
  }

  prepare(): boolean {
    if (!this.admitted || !this.visible || this.node.isDisposed() || !this.node.isEnabled()) return false;
    const rootWorld = this.node.computeWorldMatrix(!this.node.isSynchronized());
    if (this.dirty || !this.rootWorld.equals(rootWorld)) {
      this.dirty = false;
      this.rootWorld.copyFrom(rootWorld);
      for (const decal of this.decals) {
        decal.local.multiplyToRef(rootWorld, this.world);
        decal.world.copyFrom(this.world);
        decal.valid = Math.abs(this.world.determinant()) > 1e-8;
        if (!decal.valid) continue;
        this.world.invertToRef(decal.inverseWorld);
        decal.bounds.update(this.world);
        encloseDecal(decal, this.world);
      }
    }
    return this.decals.length > 0;
  }

  dispose(): void {
    this.node.onDisposeObservable.remove(this.disposed);
  }
}

export class SceneDecalHost {
  readonly scene: Scene;
  readonly owners = new Map<string, DecalActorOwner>();
  private readonly dynamicPool: DynamicDecalEntry[] = [];
  private dynamicCursor = 0;
  private textureResolver: DecalTextureResolver | null = null;
  private readonly planes: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
  private readonly viewProjection = Matrix.Identity();
  private readonly invViewProjection = Matrix.Identity();
  private readonly batches: DecalBatch[] = [];
  private readonly batchMap = new Map<string, DecalBatch>();
  private cube: Mesh | null = null;
  private readonly effects = new Map<string, Effect>();
  private scratchWorld = new Float32Array(0);
  private scratchInv0 = new Float32Array(0);
  private scratchInv1 = new Float32Array(0);
  private scratchInv2 = new Float32Array(0);
  private scratchInv3 = new Float32Array(0);
  private scratchTint = new Float32Array(0);
  private scratchParams = new Float32Array(0);
  private lastVisibleCount = 0;
  private totalDraws = 0;
  private preparedFrameId = -1;
  private preparedCamera: Camera | null = null;
  private lastPreparedResult = false;
  private demandRevision = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    scene.onDisposeObservable.addOnce(() => this.dispose());
  }

  get revision(): number {
    return this.demandRevision;
  }

  setTextureResolver(resolver: DecalTextureResolver | null): void {
    this.textureResolver = resolver;
  }

  hasAnyDecals(): boolean {
    for (const owner of this.owners.values()) {
      if (owner.decals.length > 0) return true;
    }
    for (const entry of this.dynamicPool) {
      if (entry.alive) return true;
    }
    return false;
  }

  upsertActor(actorId: string, node: TransformNode, bindings: readonly DecalBinding[], admitted = true): void {
    const existing = this.owners.get(actorId);
    const has = bindings.some((binding) => !binding.error && binding.properties.enabled && !!binding.properties.textureGuid && binding.properties.opacity > 0);
    if (!has) {
      if (existing) {
        existing.dispose();
        this.owners.delete(actorId);
        this.demandRevision += 1;
      }
      return;
    }
    let owner = existing;
    if (!owner || owner.node !== node) {
      owner?.dispose();
      owner = new DecalActorOwner(this.scene, actorId, node);
      this.owners.set(actorId, owner);
      this.demandRevision += 1;
    }
    owner.admitted = admitted;
    if (owner.update(bindings)) this.demandRevision += 1;
  }

  setActorVisible(actorId: string, visible: boolean): void {
    const owner = this.owners.get(actorId);
    if (owner) owner.visible = visible;
  }

  setActorAdmitted(actorId: string, admitted: boolean): void {
    const owner = this.owners.get(actorId);
    if (owner) owner.admitted = admitted;
  }

  removeActor(actorId: string): void {
    const owner = this.owners.get(actorId);
    if (!owner) return;
    owner.dispose();
    this.owners.delete(actorId);
    this.demandRevision += 1;
  }

  clear(): void {
    for (const owner of this.owners.values()) owner.dispose();
    this.owners.clear();
    this.dynamicPool.length = 0;
    this.dynamicCursor = 0;
    this.batches.length = 0;
    this.lastVisibleCount = 0;
    this.demandRevision += 1;
  }

  spawnDynamic(request: DynamicDecalSpawnRequest): void {
    const textureGuid = typeof request.textureGuid === "string" ? request.textureGuid.trim() : "";
    if (!textureGuid) return;
    const capacity = maxDynamicDecalsForScene(this.scene);
    if (this.dynamicPool.length > capacity) {
      this.dynamicPool.length = capacity;
      this.dynamicCursor = this.dynamicCursor % capacity;
    }
    const size: [number, number, number] = [
      request.size[0] > 0 ? request.size[0] : 1,
      request.size[1] > 0 ? request.size[1] : 1,
      request.size[2] > 0 ? request.size[2] : 1,
    ];
    const world = Matrix.Compose(
      new Vector3(size[0], size[1], size[2]),
      Quaternion.FromArray(request.rotation),
      Vector3.FromArray(request.position),
    );
    if (Math.abs(world.determinant()) <= 1e-8) return;
    const inverseWorld = world.clone().invert();
    const bounds = new BoundingInfo(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5));
    bounds.update(world);
    const center = new Vector3(world.m[12]!, world.m[13]!, world.m[14]!);
    let farthest = 0;
    for (const corner of bounds.boundingBox.vectorsWorld) {
      farthest = Math.max(farthest, Vector3.DistanceSquared(corner, center));
    }
    const properties: DecalProperties = {
      enabled: true,
      textureGuid,
      normalTextureGuid: request.normalTextureGuid?.trim() || null,
      tint: request.tint ?? [...DEFAULT_DECAL_PROPERTIES.tint],
      opacity: typeof request.opacity === "number" && Number.isFinite(request.opacity) ? Math.min(1, Math.max(0, request.opacity)) : 1,
      roughness: typeof request.roughness === "number" && Number.isFinite(request.roughness) ? Math.min(1, Math.max(0, request.roughness)) : DEFAULT_DECAL_PROPERTIES.roughness,
      blendMode: normalizeDecalBlendMode(request.blendMode),
      receiveLighting: request.receiveLighting !== false,
      size,
      fadeAngle: typeof request.fadeAngle === "number" && Number.isFinite(request.fadeAngle) ? Math.min(180, Math.max(1, request.fadeAngle)) : DEFAULT_DECAL_PROPERTIES.fadeAngle,
      sortOrder: typeof request.sortOrder === "number" && Number.isFinite(request.sortOrder) ? Math.round(request.sortOrder) : 0,
      cullDistance: typeof request.cullDistance === "number" && Number.isFinite(request.cullDistance) ? Math.max(0, request.cullDistance) : 0,
    };
    const entry: DynamicDecalEntry = {
      world,
      inverseWorld,
      center,
      radius: Math.sqrt(farthest),
      properties,
      opacityMultiplier: 1,
      alive: true,
      age: 0,
      lifetime: typeof request.lifetime === "number" && Number.isFinite(request.lifetime) && request.lifetime > 0 ? request.lifetime : 0,
      fadeOutDuration: typeof request.fadeOutDuration === "number" && Number.isFinite(request.fadeOutDuration) && request.fadeOutDuration > 0 ? request.fadeOutDuration : 0,
    };
    if (this.dynamicPool.length < capacity) {
      this.dynamicPool.push(entry);
    } else {
      const slot = this.dynamicCursor % capacity;
      this.dynamicPool[slot] = entry;
      this.dynamicCursor = (slot + 1) % capacity;
    }
    this.demandRevision += 1;
  }

  /** Advance dynamic timers by `deltaSeconds` (deterministic for tests and runtime). */
  advanceTimers(deltaSeconds: number): void {
    if (!(deltaSeconds > 0)) return;
    let expiredAny = false;
    for (const entry of this.dynamicPool) {
      if (!entry.alive || entry.lifetime <= 0) continue;
      entry.age += deltaSeconds;
      if (entry.age >= entry.lifetime) {
        entry.alive = false;
        entry.opacityMultiplier = 0;
        expiredAny = true;
      } else if (entry.fadeOutDuration > 0) {
        const remaining = entry.lifetime - entry.age;
        entry.opacityMultiplier = remaining < entry.fadeOutDuration ? Math.max(0, remaining / entry.fadeOutDuration) : 1;
      }
    }
    if (expiredAny) this.demandRevision += 1;
  }

  /**
   * Cull decals against `camera` frustum + quality-scaled `cullDistance` and group into sorted
   * instanced batches. Returns `true` when at least one decal is visible this frame.
   */
  prepare(camera: Camera, deltaSeconds = 0, force = false): boolean {
    const frameId = this.scene.getFrameId();
    if (!force && this.preparedFrameId === frameId && this.preparedCamera === camera) {
      return this.lastPreparedResult;
    }
    this.preparedFrameId = frameId;
    this.preparedCamera = camera;
    this.advanceTimers(deltaSeconds);

    this.batches.length = 0;
    this.batchMap.clear();
    this.lastVisibleCount = 0;

    camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), this.viewProjection);
    Frustum.GetPlanesToRef(this.viewProjection, this.planes);
    const camPos = camera.globalPosition ?? camera.position;
    const distanceScale = sceneRenderingSettings(this.scene).lodDistanceScale;

    const admit = (item: PreparedDecal) => {
      const textureGuid = item.properties.textureGuid;
      if (!textureGuid || item.properties.opacity * item.opacityMultiplier <= 0.004) return;
      if (item.properties.cullDistance > 0) {
        const effectiveCull = item.properties.cullDistance * distanceScale;
        const dist = Math.max(0, Vector3.Distance(camPos, item.center) - item.radius);
        if (dist > effectiveCull) return;
      }
      if (sphereFrustumSide(this.planes, item.center, item.radius) < 0) return;

      const key = `${item.properties.sortOrder}|${item.properties.blendMode}|${item.properties.receiveLighting ? 1 : 0}|${textureGuid}|${item.properties.normalTextureGuid ?? ""}`;
      let batch = this.batchMap.get(key);
      if (!batch) {
        batch = {
          key,
          sortOrder: item.properties.sortOrder,
          blendMode: item.properties.blendMode,
          receiveLighting: item.properties.receiveLighting,
          textureGuid,
          normalTextureGuid: item.properties.normalTextureGuid,
          items: [],
        };
        this.batchMap.set(key, batch);
        this.batches.push(batch);
      }
      batch.items.push(item);
      this.lastVisibleCount += 1;
    };

    for (const owner of this.owners.values()) {
      if (!owner.prepare()) continue;
      for (const decal of owner.decals) {
        if (decal.valid) admit(decal);
      }
    }
    for (const entry of this.dynamicPool) {
      if (entry.alive) admit(entry);
    }

    this.batches.sort((a, b) => a.sortOrder - b.sortOrder);
    this.lastPreparedResult = this.batches.length > 0;
    return this.lastPreparedResult;
  }

  get currentBatches(): readonly DecalBatch[] {
    return this.batches;
  }

  stats(): SceneDecalStats {
    let authored = 0;
    for (const owner of this.owners.values()) authored += owner.decals.length;
    let dynamic = 0;
    for (const entry of this.dynamicPool) if (entry.alive) dynamic += 1;
    return {
      authored,
      dynamic,
      visible: this.lastVisibleCount,
      batches: this.batches.length,
      draws: this.totalDraws,
      capacity: maxDynamicDecalsForScene(this.scene),
    };
  }

  private ensureUnitCube(): Mesh {
    if (this.cube && !this.cube.isDisposed()) return this.cube;
    const cube = CreateBox("haptic:decal-unit-cube", { size: 1 }, this.scene);
    // Keep internal decal proxy out of scene.meshes so picking, culling, shadows and readiness ignore it.
    this.scene.removeMesh(cube);
    cube.isPickable = false;
    cube.doNotSyncBoundingInfo = true;
    this.cube = cube;
    return cube;
  }

  private ensureScratch(count: number): void {
    if (this.scratchWorld.length < count * 16) {
      const cap = Math.max(count, 16);
      this.scratchWorld = new Float32Array(cap * 16);
      this.scratchInv0 = new Float32Array(cap * 4);
      this.scratchInv1 = new Float32Array(cap * 4);
      this.scratchInv2 = new Float32Array(cap * 4);
      this.scratchInv3 = new Float32Array(cap * 4);
      this.scratchTint = new Float32Array(cap * 4);
      this.scratchParams = new Float32Array(cap * 4);
    }
  }

  private effectFor(lit: boolean, hasNormalMap: boolean, cel: boolean): Effect {
    const key = `${lit ? 1 : 0}:${hasNormalMap ? 1 : 0}:${cel ? 1 : 0}`;
    const cached = this.effects.get(key);
    if (cached) return cached;
    registerDecalShaders();
    const defines: string[] = [];
    if (lit) {
      defines.push("#define DECAL_LIT");
      if (cel) defines.push("#define HAPTIC_CEL");
      else defines.push("#define HAPTIC_ENVIRONMENT");
      if (this.scene.getEngine().useExactSrgbConversions) defines.push("#define HAPTIC_EXACT_SRGB");
    }
    if (hasNormalMap) defines.push("#define DECAL_NORMAL_MAP");
    const uniforms = lit ? [...DECAL_BASE_UNIFORMS, ...HAPTIC_LIGHTING_UNIFORMS] : [...DECAL_BASE_UNIFORMS];
    const samplers = [
      "sceneDepth",
      "albedoSampler",
      ...(hasNormalMap ? ["normalSampler"] : []),
      ...(lit ? HAPTIC_LIGHTING_SAMPLERS : []),
    ];
    const uniformBuffers = lit ? ["HapticLights", "HapticClusters"] : [];
    const effect = this.scene.getEngine().createEffect(
      DECAL_SHADER_NAME,
      {
        attributes: DECAL_ATTRIBUTES,
        uniformsNames: uniforms,
        uniformBuffersNames: uniformBuffers,
        samplers,
        defines: defines.join("\n"),
        shaderLanguage: ShaderLanguage.GLSL,
      },
      this.scene.getEngine(),
    );
    this.effects.set(key, effect);
    return effect;
  }

  /** Draw all prepared decal batches against the resolved opaque depth buffer. */
  render(
    context: FrameGraphRenderContext,
    camera: Camera,
    depthHandle: FrameGraphTextureHandle,
    width: number,
    height: number,
  ): number {
    if (this.batches.length === 0) return 0;
    const engine = this.scene.getEngine();
    const cube = this.ensureUnitCube();
    const subMesh = cube.subMeshes[0];
    if (!subMesh) return 0;

    context.setTextureSamplingMode(depthHandle, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    const view = camera.getViewMatrix();
    view.multiplyToRef(camera.getProjectionMatrix(), this.viewProjection);
    if (Math.abs(this.viewProjection.determinant()) <= 1e-12) return 0;
    this.viewProjection.invertToRef(this.invViewProjection);

    const camPos = camera.globalPosition ?? camera.position;
    const cel = sceneRenderingSettings(this.scene).mode === "cel";
    const sceneLinear = this.scene.imageProcessingConfiguration.applyByPostProcess ? 1 : 0;
    let drawnBatches = 0;

    engine.setDepthBuffer(false);
    engine.setDepthWrite(false);
    // Front-face culling draws OBB back faces so entering a decal volume never near-clips it.
    engine.setState(true, 0, false, false, false);
    try {
      for (const batch of this.batches) {
        const albedo = this.textureResolver?.(batch.textureGuid) ?? null;
        if (!albedo || !albedo.isReadyOrNotBlocking()) continue;
        const normal = batch.normalTextureGuid ? (this.textureResolver?.(batch.normalTextureGuid) ?? null) : null;
        const hasNormalMap = !!normal && normal.isReadyOrNotBlocking();
        const effect = this.effectFor(batch.receiveLighting, hasNormalMap, cel);
        if (!effect.isReady()) continue;

        const count = batch.items.length;
        this.ensureScratch(count);
        for (let i = 0; i < count; i++) {
          const item = batch.items[i]!;
          item.world.copyToArray(this.scratchWorld, i * 16);
          const inv = item.inverseWorld.m;
          const o4 = i * 4;
          this.scratchInv0[o4] = inv[0]!; this.scratchInv0[o4 + 1] = inv[1]!; this.scratchInv0[o4 + 2] = inv[2]!; this.scratchInv0[o4 + 3] = inv[3]!;
          this.scratchInv1[o4] = inv[4]!; this.scratchInv1[o4 + 1] = inv[5]!; this.scratchInv1[o4 + 2] = inv[6]!; this.scratchInv1[o4 + 3] = inv[7]!;
          this.scratchInv2[o4] = inv[8]!; this.scratchInv2[o4 + 1] = inv[9]!; this.scratchInv2[o4 + 2] = inv[10]!; this.scratchInv2[o4 + 3] = inv[11]!;
          this.scratchInv3[o4] = inv[12]!; this.scratchInv3[o4 + 1] = inv[13]!; this.scratchInv3[o4 + 2] = inv[14]!; this.scratchInv3[o4 + 3] = inv[15]!;
          this.scratchTint[o4] = item.properties.tint[0];
          this.scratchTint[o4 + 1] = item.properties.tint[1];
          this.scratchTint[o4 + 2] = item.properties.tint[2];
          this.scratchTint[o4 + 3] = item.properties.opacity * item.opacityMultiplier;
          const fadeRad = (item.properties.fadeAngle * Math.PI) / 180;
          this.scratchParams[o4] = item.properties.roughness;
          this.scratchParams[o4 + 1] = Math.cos(fadeRad);
          this.scratchParams[o4 + 2] = 0;
          this.scratchParams[o4 + 3] = 0;
        }
        cube.thinInstanceSetBuffer("matrix", this.scratchWorld.subarray(0, count * 16), 16, false);
        cube.thinInstanceSetBuffer("decalInv0", this.scratchInv0.subarray(0, count * 4), 4, false);
        cube.thinInstanceSetBuffer("decalInv1", this.scratchInv1.subarray(0, count * 4), 4, false);
        cube.thinInstanceSetBuffer("decalInv2", this.scratchInv2.subarray(0, count * 4), 4, false);
        cube.thinInstanceSetBuffer("decalInv3", this.scratchInv3.subarray(0, count * 4), 4, false);
        cube.thinInstanceSetBuffer("decalTintOpacity", this.scratchTint.subarray(0, count * 4), 4, false);
        cube.thinInstanceSetBuffer("decalParams", this.scratchParams.subarray(0, count * 4), 4, false);
        cube.thinInstanceCount = count;

        engine.enableEffect(effect);
        cube._bind(subMesh, effect, Material.TriangleFillMode);
        effect.setMatrix("viewProjection", this.viewProjection);
        effect.setMatrix("invViewProjection", this.invViewProjection);
        effect.setMatrix("view", view);
        effect.setFloat2("invViewport", 1 / Math.max(1, width), 1 / Math.max(1, height));
        effect.setFloat2("depthRange", 2, -1);
        effect.setFloat("reverseDepth", engine.useReverseDepthBuffer ? 1 : 0);
        effect.setVector3("cameraPosition", camPos);
        effect.setFloat("sceneLinear", sceneLinear);
        effect.setFloat("blendModeId", blendModeId(batch.blendMode));
        bindSceneFog(effect, this.scene);
        bindSceneFogColor(effect, this.scene);
        context.bindTextureHandle(effect, "sceneDepth", depthHandle);
        effect.setTexture("albedoSampler", albedo);
        if (hasNormalMap && normal) effect.setTexture("normalSampler", normal);
        if (batch.receiveLighting) {
          bindHapticLightingUniforms(this.scene, effect, cel, true);
        }
        engine.setAlphaMode(babylonAlphaMode(batch.blendMode));
        engine.drawElementsType(Material.TriangleFillMode, subMesh.indexStart, subMesh.indexCount, count);
        drawnBatches += 1;
        this.totalDraws += 1;
      }
    } finally {
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setDepthWrite(true);
      engine.setDepthBuffer(true);
      engine.setState(true, 0, false, true, false);
    }
    return drawnBatches;
  }

  dispose(): void {
    for (const owner of this.owners.values()) owner.dispose();
    this.owners.clear();
    this.dynamicPool.length = 0;
    this.batches.length = 0;
    this.cube?.dispose();
    this.cube = null;
    for (const effect of this.effects.values()) effect.dispose();
    this.effects.clear();
  }
}

const hosts = new WeakMap<Scene, SceneDecalHost>();

export function sceneDecalHost(scene: Scene): SceneDecalHost {
  let host = hosts.get(scene);
  if (!host) {
    host = new SceneDecalHost(scene);
    hosts.set(scene, host);
  }
  return host;
}

export function sceneHasDecals(scene: Scene): boolean {
  return hosts.get(scene)?.hasAnyDecals() ?? false;
}

export function sceneDecalStats(scene: Scene): SceneDecalStats {
  return sceneDecalHost(scene).stats();
}

export function setDecalTextureResolver(scene: Scene, resolver: DecalTextureResolver | null): void {
  sceneDecalHost(scene).setTextureResolver(resolver);
}

export function upsertDecals(scene: Scene, actorId: string, node: TransformNode, bindings: readonly DecalBinding[], admitted = true): void {
  if (!bindings.length && !hosts.has(scene)) return;
  sceneDecalHost(scene).upsertActor(actorId, node, bindings, admitted);
}

export function setDecalsVisible(scene: Scene, actorId: string, visible: boolean): void {
  hosts.get(scene)?.setActorVisible(actorId, visible);
}

export function setDecalsAdmitted(scene: Scene, actorId: string, admitted: boolean): void {
  hosts.get(scene)?.setActorAdmitted(actorId, admitted);
}

export function removeDecals(scene: Scene, actorId: string): void {
  hosts.get(scene)?.removeActor(actorId);
}

export function clearDecals(scene: Scene): void {
  hosts.get(scene)?.clear();
}

export function spawnDynamicDecal(scene: Scene, request: DynamicDecalSpawnRequest): void {
  sceneDecalHost(scene).spawnDynamic(request);
}

/** FrameGraph render pass that projects all visible instanced decals onto opaque scene geometry. */
export class FrameGraphDecalTask extends FrameGraphTask {
  camera!: Camera;
  targetTexture!: FrameGraphTextureHandle;
  depthTexture!: FrameGraphTextureHandle;
  draws = 0;

  constructor(name: string, graph: FrameGraph) {
    super(name, graph);
  }

  override getClassName(): string {
    return "FrameGraphDecalTask";
  }

  override isReady(): boolean {
    return true;
  }

  override record(): void {
    const graph = this._frameGraph;
    const size = graph.textureManager.getTextureAbsoluteDimensions(this.targetTexture);
    const pass = graph.addRenderPass(this.name);
    pass.setRenderTarget(this.targetTexture);
    pass.addDependencies([this.depthTexture]);
    pass.setExecuteFunc((context) => {
      const host = hosts.get(graph.scene);
      if (!host) return;
      this.draws += host.render(context, this.camera, this.depthTexture, size.width, size.height);
    });
    const disabled = graph.addRenderPass(`${this.name}_disabled`, true);
    disabled.setRenderTarget(this.targetTexture);
    disabled.setExecuteFunc(() => {});
  }
}

function blendsForMesh(mesh: AbstractMesh, scene: Scene): boolean {
  if (mesh.visibility < 1 || mesh.hasVertexAlpha) return true;
  const material = mesh.material ?? scene.defaultMaterial;
  if (!material) return false;
  if (material instanceof MultiMaterial) {
    const subMaterials = material.subMaterials;
    for (let index = 0; index < subMaterials.length; index += 1) {
      if (subMaterials[index]?.needAlphaBlendingForMesh(mesh)) return true;
    }
    return false;
  }
  return material.needAlphaBlendingForMesh(mesh);
}

function listed(list: readonly AbstractMesh[], count: number, mesh: AbstractMesh): boolean {
  for (let index = 0; index < count; index += 1) if (list[index] === mesh) return true;
  return false;
}

class DecalSplitTask extends FrameGraphTask {
  private readonly onSplit: () => void;
  constructor(name: string, graph: FrameGraph, onSplit: () => void) {
    super(name, graph);
    this.onSplit = onSplit;
  }
  override getClassName(): string {
    return "DecalSplitTask";
  }
  override record(): void {
    this._frameGraph.addPass(this.name).setExecuteFunc(this.onSplit);
  }
}

export interface DecalSplitGraphOptions {
  frameGraph: FrameGraph;
  camera: Camera;
  cull: FrameGraphCullObjectsTask;
  objects: ManagedShadowObjectRendererTask;
  targetColor: FrameGraphTextureHandle;
  targetDepth: FrameGraphTextureHandle;
}

/**
 * Lightweight opaque/transparent split used when decals exist without water scene copy:
 *
 *   Forward cull → Decal split → Forward objects (opaque) → Forward decals → Forward transparent
 *
 * On frames where zero decals enter the camera frustum, both `Forward decals` and
 * `Forward transparent` stay disabled and `Forward objects` draws everything in one pass.
 */
export class DecalSplitGraph {
  readonly split: FrameGraphTask;
  readonly decalTask: FrameGraphDecalTask;
  readonly transparent: ManagedShadowObjectRendererTask;
  readonly afterObjects: FrameGraphTask[];
  readonly shadowReceivers: ManagedShadowObjectRendererTask[];
  private readonly scene: Scene;
  private readonly cull: FrameGraphCullObjectsTask;
  private readonly objects: ManagedShadowObjectRendererTask;
  private readonly transparentMeshes: AbstractMesh[] = [];
  private readonly noParticles: IParticleSystem[] = [];
  private readonly transparentList: FrameGraphObjectList;
  private readonly probeMeshes: AbstractMesh[] = [];
  private readonly probeList: FrameGraphObjectList = { meshes: null, particleSystems: null };
  private probing: FrameGraphObjectList | undefined;
  private camera: Camera;
  private visible: boolean | undefined;

  constructor(options: DecalSplitGraphOptions) {
    const { frameGraph: graph, camera } = options;
    this.scene = graph.scene;
    this.camera = camera;
    this.cull = options.cull;
    this.objects = options.objects;
    this.transparentList = { meshes: this.transparentMeshes, particleSystems: this.noParticles };

    this.decalTask = new FrameGraphDecalTask("Forward decals", graph);
    this.decalTask.camera = camera;
    this.decalTask.targetTexture = options.targetColor;
    this.decalTask.depthTexture = options.targetDepth;

    const transparent = new ManagedShadowObjectRendererTask("Forward transparent", graph, this.scene, { doNotChangeAspectRatio: false });
    this.transparent = transparent;
    transparent.mainView = true;
    transparent.camera = camera;
    transparent.targetTexture = options.targetColor;
    transparent.depthTexture = options.targetDepth;
    transparent.renderDepthOnlyMeshes = false;
    transparent.renderOpaqueMeshes = false;
    transparent.renderAlphaTestMeshes = false;
    transparent.enableBoundingBoxRendering = false;
    for (let group = RenderingManager.MIN_RENDERINGGROUPS; group < RenderingManager.MAX_RENDERINGGROUPS; group += 1) {
      transparent.objectRenderer.setRenderingAutoClearDepthStencil(group, false);
    }
    transparent.objectList = this.transparentList;

    this.split = new DecalSplitTask("Decal split", graph, () => this.splitFrame());
    this.afterObjects = [this.decalTask, transparent];
    this.shadowReceivers = [transparent];
    this.apply(false);
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.decalTask.camera = camera;
    this.transparent.camera = camera;
  }

  beginProbe(all: FrameGraphObjectList): void {
    if (this.probing) return;
    this.probing = this.transparent.objectList;
    const meshes = all.meshes ?? this.scene.meshes;
    const probe = this.probeMeshes;
    let count = 0;
    for (let index = 0; index < meshes.length; index += 1) {
      const mesh = meshes[index]!;
      if (blendsForMesh(mesh, this.scene)) probe[count++] = mesh;
    }
    probe.length = count;
    this.probeList.meshes = probe;
    this.probeList.particleSystems = all.particleSystems ?? this.noParticles;
    this.transparent.objectList = this.probeList;
  }

  endProbe(): void {
    const saved = this.probing;
    if (!saved) return;
    this.probing = undefined;
    this.transparent.objectList = saved;
    this.probeMeshes.length = 0;
    this.probeList.meshes = null;
  }

  private splitFrame(): void {
    const host = hosts.get(this.scene);
    const dt = Math.max(0, this.scene.getEngine().getDeltaTime() / 1000);
    const visible = host ? host.prepare(this.camera, dt) : false;
    const list = this.transparentMeshes;
    if (visible) {
      const culled = this.cull.outputObjectList;
      const meshes = culled.meshes ?? this.scene.meshes;
      let count = 0;
      for (let index = 0; index < meshes.length; index += 1) {
        const mesh = meshes[index]!;
        if (blendsForMesh(mesh, this.scene)) list[count++] = mesh;
      }
      const systems = culled.particleSystems ?? this.scene.particleSystems;
      for (let index = 0; index < systems.length; index += 1) {
        const system = systems[index]!;
        const emitter = system.emitter;
        if (!emitter || !("position" in emitter) || !system.isStarted()) continue;
        if (listed(list, count, emitter) || meshes.indexOf(emitter) === -1) continue;
        list[count++] = emitter;
      }
      list.length = count;
      this.transparentList.particleSystems = systems;
    } else if (list.length) {
      list.length = 0;
    }
    this.apply(visible);
  }

  private apply(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.decalTask.disabled = !visible;
    this.transparent.disabled = !visible;
    this.objects.renderTransparentMeshes = !visible;
    this.objects.renderParticles = !visible;
    this.objects.renderSprites = !visible;
  }

  dispose(): void {
    this.split.dispose();
    this.decalTask.dispose();
    this.transparent.dispose();
  }
}

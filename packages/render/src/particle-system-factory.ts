import {
  Color4,
  Constants,
  GPUParticleSystem,
  NodeMaterialModes,
  ParticleSystem,
  RawTexture,
  Vector3,
  type AbstractEngine,
  type FactorGradient,
  type IParticleSystem,
  type NodeMaterial,
  type Scene,
} from "@babylonjs/core";
import type {
  BasicEmitterPlan,
  BasicPlanFactorKey,
  ParticleColorTuple,
  ParticleEmitterShape,
  ParticleSimBackend,
  ParticleVec3Tuple,
} from "@babylonslate/assets";
import { prewarmMaterial } from "./material-compiler";
import { isDisposedNodeMaterial } from "./gpu-resource-live";
import { prepareNodeMaterialParticleBindings } from "./node-material-particles";
import { PARTICLE_BILLBOARD_MODES, PARTICLE_BLEND_MODES } from "./particle-render-modes";
import { markSceneReadinessDirty, SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";

export function gpuParticlesSupported(engine: AbstractEngine, requested = true): boolean {
  const caps = engine.getCaps();
  return requested && (caps.supportTransformFeedbacks === true || caps.supportComputeShaders === true);
}

/** The simulation Babylon picks for a GPU system on this engine (compute first), or the CPU fallback. */
export function particleSimBackend(engine: AbstractEngine, requested = true): ParticleSimBackend {
  if (!gpuParticlesSupported(engine, requested)) return "cpu";
  return engine.getCaps().supportComputeShaders ? "compute" : "transformFeedback";
}

/**
 * Babylon readiness only: CPU and GPU `isReady()` require a ready `particleTexture`.
 * The particle Material draws the look, so no shader samples it. Owned by the one system
 * it is assigned to and released by that system's default `dispose()`.
 */
export function createParticleReadinessTexture(scene: Scene): RawTexture {
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene,
    false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
  texture.name = "slate:particleReadiness";
  return texture;
}

/** Babylon 9.20 GPU internals behind the ring claim and in-place gradient edits. */
type GpuInternals = {
  _currentActiveCount: number;
  _writePointer: number;
  _refreshColorGradient: (reorder?: boolean) => void;
  _refreshFactorGradient: (gradients: FactorGradient[] | null, textureName: string) => void;
};
const GPU_INTERNAL_TYPES: Readonly<Record<keyof GpuInternals, string>> = {
  _currentActiveCount: "number",
  _writePointer: "number",
  _refreshColorGradient: "function",
  _refreshFactorGradient: "function",
};

/** Throws on any other layout, so a Babylon upgrade fails the slot instead of recycling live particles. */
function gpuInternals(system: GPUParticleSystem): GpuInternals {
  const view = system as unknown as Record<string, unknown>;
  for (const [member, type] of Object.entries(GPU_INTERNAL_TYPES)) {
    if (typeof view[member] !== type) throw new Error("Unsupported Babylon GPU particle layout.");
  }
  return system as unknown as GpuInternals;
}

type FactorGradientFamily = {
  key: Exclude<keyof BasicEmitterPlan["gradients"], "color">;
  texture: string;
  list: (system: IParticleSystem) => FactorGradient[] | null;
  add: (system: IParticleSystem, key: BasicPlanFactorKey) => void;
  remove: (system: IParticleSystem, gradient: number) => void;
};

/** Every factor gradient a Basic plan sets; each replaces its fixed counterpart in Babylon. */
const FACTOR_GRADIENTS: readonly FactorGradientFamily[] = [
  { key: "size", texture: "_sizeGradientsTexture", list: (system) => system.getSizeGradients(),
    add: (system, key) => system.addSizeGradient(key.t, key.factor), remove: (system, t) => system.removeSizeGradient(t) },
  { key: "angularSpeed", texture: "_angularSpeedGradientsTexture", list: (system) => system.getAngularSpeedGradients(),
    add: (system, key) => system.addAngularSpeedGradient(key.t, key.factor), remove: (system, t) => system.removeAngularSpeedGradient(t) },
  { key: "velocity", texture: "_velocityGradientsTexture", list: (system) => system.getVelocityGradients(),
    add: (system, key) => system.addVelocityGradient(key.t, key.factor), remove: (system, t) => system.removeVelocityGradient(t) },
  { key: "limitVelocity", texture: "_limitVelocityGradientsTexture", list: (system) => system.getLimitVelocityGradients(),
    add: (system, key) => system.addLimitVelocityGradient(key.t, key.factor), remove: (system, t) => system.removeLimitVelocityGradient(t) },
  { key: "drag", texture: "_dragGradientsTexture", list: (system) => system.getDragGradients(),
    add: (system, key) => system.addDragGradient(key.t, key.factor), remove: (system, t) => system.removeDragGradient(t) },
];

/**
 * GPU system with emit-rate control that claims its whole slot ring. Babylon sizes the
 * ring from rate × lifetime and wraps the write pointer over live particles when bursts
 * overlap; claiming `capacity` slots fixes the modulus, so the oldest particle is
 * recycled only after `capacity` newer emissions (the CPU fallback drops new particles
 * instead). Never-emitted slots have zero size and draw nothing.
 */
class OwnedGPUParticleSystem extends GPUParticleSystem {
  simulationDelta = 0;

  constructor(name: string, capacity: number, scene: Scene) {
    super(name, { capacity, emitRateControl: true }, scene);
    try {
      gpuInternals(this)._currentActiveCount = capacity;
    } catch (error) {
      // The base constructor already joined the scene and allocated its textures.
      this.dispose();
      throw error;
    }
  }

  /** Babylon 9.20's animate clock, including prewarm. */
  override animate(preWarm = false): void {
    super.animate(preWarm);
    this.simulationDelta = this.updateSpeed *
      (preWarm ? this.preWarmStepOffset : this.getScene()?.getAnimationRatio() || 1);
  }

  /** `reset()` zeroes the ring; claim it again. */
  override reset(): void {
    super.reset();
    gpuInternals(this)._currentActiveCount = this.getCapacity();
  }

  /**
   * Rebake gradient textures after their keys were edited in place. Unlike Babylon's
   * public `forceRefreshGradients()` this never resets, so live particles survive.
   */
  refreshGradientTextures(): void {
    const internals = gpuInternals(this);
    internals._refreshColorGradient();
    for (const family of FACTOR_GRADIENTS) internals._refreshFactorGradient(family.list(this), family.texture);
    this._recreateUpdateEffect();
  }
}

/** Read on the draw observable, after Babylon has submitted this GPU update. */
export function particleSimulationDelta(system: IParticleSystem): number {
  return system instanceof OwnedGPUParticleSystem ? system.simulationDelta : 0;
}

/** Historical maxima also cover particles emitted before a lifetime edit. */
export function particleLifetimeBound(system: IParticleSystem): number {
  let lifetime = Math.max(system.minLifeTime, system.maxLifeTime);
  for (const gradient of system.getLifeTimeGradients() ?? []) {
    // Babylon's GPU update shaders use these values as absolute lifetimes.
    lifetime = Math.max(lifetime, gradient.factor1, gradient.factor2 ?? gradient.factor1);
  }
  if (!Number.isFinite(lifetime) || lifetime < 0) throw new Error("Particle lifetime must be finite and nonnegative.");
  return lifetime;
}

/** A native system that owns its readiness texture; GPU systems claim their slot ring. */
export function createBabylonParticleSystem(
  name: string,
  scene: Scene,
  capacity: number,
  gpu: boolean,
): IParticleSystem {
  const system = gpu ? new OwnedGPUParticleSystem(name, capacity, scene) : new ParticleSystem(name, capacity, scene);
  system.particleTexture = createParticleReadinessTexture(scene);
  return system;
}

/**
 * - `create`: the whole plan onto a fresh system, before its Material binds (GPU render
 *   defines and vertex streams depend on the gradient textures).
 * - `live`: values the update shader reads as uniforms or textures; particles survive.
 *   Gradient keys are edited in place when the key counts match.
 * - `respawn`: shape class or gradient key-count changes; GPU particles restart.
 * `live` and `respawn` never write `updateSpeed` (pause owns it), prewarm or the stop duration.
 */
export type BasicPlanApplyScope = "create" | "live" | "respawn";

export function applyBasicEmitterPlan(system: IParticleSystem, plan: BasicEmitterPlan, scope: BasicPlanApplyScope): void {
  system.emitRate = plan.emitRate;
  system.minLifeTime = plan.lifeTime.min;
  system.maxLifeTime = plan.lifeTime.max;
  system.minEmitPower = plan.emitPower.min;
  system.maxEmitPower = plan.emitPower.max;
  system.minSize = plan.size.min;
  system.maxSize = plan.size.max;
  system.minScaleX = plan.scaleX.min;
  system.maxScaleX = plan.scaleX.max;
  system.minScaleY = plan.scaleY.min;
  system.maxScaleY = plan.scaleY.max;
  system.minInitialRotation = plan.initialRotation.min;
  system.maxInitialRotation = plan.initialRotation.max;
  system.minAngularSpeed = plan.angularSpeed.min;
  system.maxAngularSpeed = plan.angularSpeed.max;
  system.gravity.copyFromFloats(plan.gravity[0], plan.gravity[1], plan.gravity[2]);
  system.limitVelocityDamping = plan.limitVelocityDamping;
  if (scope === "create") {
    system.updateSpeed = plan.updateSpeed;
    system.targetStopDuration = plan.targetStopDuration;
    system.preWarmCycles = plan.preWarmCycles;
    system.preWarmStepOffset = plan.preWarmStepOffset;
    system.isBillboardBased = true;
    system.billboardMode = PARTICLE_BILLBOARD_MODES[plan.billboard];
  }
  system.blendMode = PARTICLE_BLEND_MODES[plan.blendMode];
  if (scope === "create") system.isLocal = plan.isLocal;
  // Recreating an emitter of the same class keeps the GPU update-shader defines.
  applyShape(system, plan.shape);
  const inPlace = scope === "live" && editGradientsInPlace(system, plan.gradients);
  if (!inPlace) replaceGradients(system, plan.gradients);
  if (!(system instanceof OwnedGPUParticleSystem) || scope === "create") return;
  // Gradient adds and removes release Babylon's buffers, and WebGL2 keeps vertex
  // arrays recorded for the old update program until reset() releases them.
  if (inPlace) system.refreshGradientTextures();
  else system.reset();
}

function vec3(value: ParticleVec3Tuple): Vector3 {
  return new Vector3(value[0], value[1], value[2]);
}

function color4(value: ParticleColorTuple): Color4 {
  return new Color4(value[0], value[1], value[2], value[3]);
}

function applyShape(system: IParticleSystem, shape: ParticleEmitterShape): void {
  switch (shape.kind) {
    case "point":
      system.createPointEmitter(vec3(shape.direction1), vec3(shape.direction2));
      return;
    case "box":
      system.createBoxEmitter(vec3(shape.direction1), vec3(shape.direction2), vec3(shape.min), vec3(shape.max));
      return;
    case "sphere":
      if (shape.direction.mode === "directed") {
        system.createDirectedSphereEmitter(shape.radius, vec3(shape.direction.direction1), vec3(shape.direction.direction2))
          .radiusRange = shape.radiusRange;
      } else {
        system.createSphereEmitter(shape.radius, shape.radiusRange).directionRandomizer = shape.direction.randomizer;
      }
      return;
    case "hemisphere":
      system.createHemisphericEmitter(shape.radius, shape.radiusRange).directionRandomizer = shape.randomizer;
      return;
    case "cylinder":
      if (shape.direction.mode === "directed") {
        system.createDirectedCylinderEmitter(shape.radius, shape.height, shape.radiusRange,
          vec3(shape.direction.direction1), vec3(shape.direction.direction2));
      } else {
        system.createCylinderEmitter(shape.radius, shape.height, shape.radiusRange, shape.direction.randomizer);
      }
      return;
    case "cone": {
      const directed = shape.direction.mode === "directed" ? shape.direction : null;
      const cone = directed
        ? system.createDirectedConeEmitter(shape.radius, shape.angle, vec3(directed.direction1), vec3(directed.direction2))
        : system.createConeEmitter(shape.radius, shape.angle);
      // Babylon's constructor fixes these at 1, 1 and false; they exist only on the instance.
      cone.radiusRange = shape.radiusRange;
      cone.heightRange = shape.heightRange;
      cone.emitFromSpawnPointOnly = shape.emitFromSpawnPointOnly;
      if (shape.direction.mode === "radial") cone.directionRandomizer = shape.direction.randomizer;
      return;
    }
  }
}

function replaceGradients(system: IParticleSystem, gradients: BasicEmitterPlan["gradients"]): void {
  for (const gradient of [...(system.getColorGradients() ?? [])]) system.removeColorGradient(gradient.gradient);
  for (const key of gradients.color) {
    system.addColorGradient(key.t, color4(key.color1), key.color2 ? color4(key.color2) : undefined);
  }
  for (const family of FACTOR_GRADIENTS) {
    for (const gradient of [...(family.list(system) ?? [])]) family.remove(system, gradient.gradient);
    for (const key of gradients[family.key] ?? []) family.add(system, key);
  }
}

/** Mutates the existing key objects when every family keeps its key count and colour signature. */
function editGradientsInPlace(system: IParticleSystem, gradients: BasicEmitterPlan["gradients"]): boolean {
  const colors = system.getColorGradients() ?? [];
  if (colors.length !== gradients.color.length) return false;
  if (gradients.color.some((key, index) => !key.color2 !== !colors[index]!.color2)) return false;
  for (const family of FACTOR_GRADIENTS) {
    if ((family.list(system)?.length ?? 0) !== (gradients[family.key]?.length ?? 0)) return false;
  }
  // Both sides are sorted by t, so keys line up by index.
  gradients.color.forEach((key, index) => {
    const gradient = colors[index]!;
    gradient.gradient = key.t;
    gradient.color1.copyFromFloats(key.color1[0], key.color1[1], key.color1[2], key.color1[3]);
    if (key.color2) gradient.color2?.copyFromFloats(key.color2[0], key.color2[1], key.color2[2], key.color2[3]);
  });
  for (const family of FACTOR_GRADIENTS) {
    const existing = family.list(system) ?? [];
    (gradients[family.key] ?? []).forEach((key, index) => {
      existing[index]!.gradient = key.t;
      existing[index]!.factor1 = key.factor;
    });
  }
  return true;
}

const pendingParticleMaterials = new WeakMap<IParticleSystem, () => void>();

/**
 * Binds a particle-domain Material after `applyBasicEmitterPlan(..., "create")`. A later
 * bind replaces a pending one. The promise rejects when the Material cannot prepare.
 */
export function bindParticleMaterial(system: IParticleSystem, material: NodeMaterial): Promise<void> {
  pendingParticleMaterials.get(system)?.();
  const scene = system.getScene();
  if (!scene || material.mode !== NodeMaterialModes.Particle || isDisposedNodeMaterial(material, scene)) {
    throw new Error("Particle material must be a live particle-domain instance in the system's owning scene.");
  }
  system.particleTexture ??= createParticleReadinessTexture(scene);
  return bindReadyParticleMaterial(system, material, scene);
}

function bindReadyParticleMaterial(system: IParticleSystem, material: NodeMaterial, scene: Scene): Promise<void> {
  const readiness = { isReady: () => false };
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Standalone factory consumers may leave preparation to scene readiness.
  // The returned promise still rejects for an owning service to diagnose and retire.
  void ready.catch(() => {});
  const cancel = () => {
    if (pendingParticleMaterials.get(system) !== cancel) return;
    pendingParticleMaterials.delete(system);
    scene.removeIsReadyCheck(readiness);
    system.onDisposeObservable.remove(disposeObserver);
    if (timer !== undefined) clearTimeout(timer);
    markSceneReadinessDirty(scene);
    resolve();
  };
  const disposeObserver = system.onDisposeObservable.addOnce(cancel);
  pendingParticleMaterials.set(system, cancel);
  scene.addIsReadyCheck(readiness);
  // Custom checks join strict readiness without a Scene observable; admit the
  // new check by invalidating the coordinator's cached readiness result.
  markSceneReadinessDirty(scene);
  const fail = (error: unknown) => {
    if (pendingParticleMaterials.get(system) !== cancel) return;
    reject(error);
    cancel();
  };
  const timer = setTimeout(() => fail(new Error("Particle material preparation timed out.")), SCENE_SHADER_WARM_TIMEOUT_MS);
  // Babylon's first NodeMaterial build can finish asynchronously. Creating the
  // particle effect before then registers no fragment source and fetches a .fx URL.
  void prewarmMaterial(material, null).then(() => {
    if (pendingParticleMaterials.get(system) !== cancel || scene.isDisposed) return;
    if (isDisposedNodeMaterial(material, scene)) throw new Error("Particle material was disposed before its build completed.");
    prepareNodeMaterialParticleBindings(material);
    material.createEffectForParticles(system);
    cancel();
  }).catch(fail);
  return ready;
}

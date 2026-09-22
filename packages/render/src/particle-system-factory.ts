import {
  Color4,
  GPUParticleSystem,
  NodeMaterialModes,
  ParticleSystem,
  Vector3,
  type AbstractEngine,
  type IParticleSystem,
  type NodeMaterial,
  type Scene,
  type Texture,
} from "@babylonjs/core";
import { ParticleTextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Particle/particleTextureBlock";
import { prewarmMaterial } from "./material-compiler";
import { isDisposedNodeMaterial } from "./gpu-resource-live";
import { prepareNodeMaterialParticleBindings } from "./node-material-particles";
import { markSceneReadinessDirty, SCENE_SHADER_WARM_TIMEOUT_MS } from "./scene-perf";
import {
  applyParticleEmitterPayload,
  resolveParticleEmitterCapacity,
  type ParticleApplyTarget,
  type ParticleEmitterPayload,
  type ParticleSystemPayload,
} from "@babylonslate/assets";

export function gpuParticlesSupported(engine: AbstractEngine, requested = true): boolean {
  const caps = engine.getCaps();
  return requested && (caps.supportTransformFeedbacks === true || caps.supportComputeShaders === true);
}

/** Babylon 9.20's animate clock, including prewarm. No private native fields. */
class OwnedGPUParticleSystem extends GPUParticleSystem {
  simulationDelta = 0;

  override animate(preWarm = false): void {
    super.animate(preWarm);
    this.simulationDelta = this.updateSpeed *
      (preWarm ? this.preWarmStepOffset : this.getScene()?.getAnimationRatio() || 1);
  }
}

/** Read on the draw observable, after Babylon has submitted this GPU update. */
export function particleSimulationDelta(system: IParticleSystem): number {
  return system instanceof OwnedGPUParticleSystem ? system.simulationDelta : 0;
}

/** Historical maxima also cover particles emitted before a lifetime edit. */
export function particleLifetimeBound(system: IParticleSystem): number {
  let factor = 1;
  for (const gradient of system.getLifeTimeGradients() ?? []) {
    factor = Math.max(factor, gradient.factor1, gradient.factor2 ?? gradient.factor1);
  }
  const lifetime = Math.max(system.minLifeTime, system.maxLifeTime) * factor;
  if (!Number.isFinite(lifetime) || lifetime < 0) throw new Error("Particle lifetime must be finite and nonnegative.");
  return lifetime;
}

export function createBabylonParticleSystem(
  name: string,
  scene: Scene,
  capacity: number,
  gpu: boolean,
): IParticleSystem {
  if (gpu) {
    return new OwnedGPUParticleSystem(name, { capacity, emitRateControl: true }, scene);
  }
  return new ParticleSystem(name, capacity, scene);
}

function vec3(value: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(value.x, value.y, value.z);
}

/** Adapt a live Babylon system so assets apply-mapping can run without importing Babylon. */
export function bindParticleApplyTarget(
  system: IParticleSystem,
): ParticleApplyTarget {
  return {
    get emitRate() {
      return system.emitRate;
    },
    set emitRate(value) {
      system.emitRate = value;
    },
    get minLifeTime() {
      return system.minLifeTime;
    },
    set minLifeTime(value) {
      system.minLifeTime = value;
    },
    get maxLifeTime() {
      return system.maxLifeTime;
    },
    set maxLifeTime(value) {
      system.maxLifeTime = value;
    },
    get minEmitPower() {
      return system.minEmitPower;
    },
    set minEmitPower(value) {
      system.minEmitPower = value;
    },
    get maxEmitPower() {
      return system.maxEmitPower;
    },
    set maxEmitPower(value) {
      system.maxEmitPower = value;
    },
    get gravity() {
      return system.gravity;
    },
    set gravity(value) {
      system.gravity.copyFromFloats(value.x, value.y, value.z);
    },
    get minSize() {
      return system.minSize;
    },
    set minSize(value) {
      system.minSize = value;
    },
    get maxSize() {
      return system.maxSize;
    },
    set maxSize(value) {
      system.maxSize = value;
    },
    get minAngularSpeed() {
      return system.minAngularSpeed;
    },
    set minAngularSpeed(value) {
      system.minAngularSpeed = value;
    },
    get maxAngularSpeed() {
      return system.maxAngularSpeed;
    },
    set maxAngularSpeed(value) {
      system.maxAngularSpeed = value;
    },
    get isLocal() {
      return system.isLocal;
    },
    set isLocal(value) {
      system.isLocal = value;
    },
    get isBillboardBased() {
      return system.isBillboardBased;
    },
    set isBillboardBased(value) {
      system.isBillboardBased = value;
    },
    get billboardMode() {
      return system.billboardMode;
    },
    set billboardMode(value) {
      system.billboardMode = value;
    },
    get blendMode() {
      return system.blendMode;
    },
    set blendMode(value) {
      system.blendMode = value;
    },
    get preWarmCycles() {
      return system.preWarmCycles;
    },
    set preWarmCycles(value) {
      system.preWarmCycles = value;
    },
    get preWarmStepOffset() {
      return system.preWarmStepOffset;
    },
    set preWarmStepOffset(value) {
      system.preWarmStepOffset = value;
    },
    get targetStopDuration() {
      return system.targetStopDuration;
    },
    set targetStopDuration(value) {
      system.targetStopDuration = value;
    },
    get capacity() {
      return system.getCapacity();
    },
    set capacity(_value) {
      /* Constructor-only on both CPU and GPU systems. */
    },
    get activeParticleCount() {
      return (system as GPUParticleSystem).activeParticleCount;
    },
    set activeParticleCount(value) {
      if ("activeParticleCount" in system) {
        (system as GPUParticleSystem).activeParticleCount = value;
      }
    },
    addColorGradient: (gradient, color) => {
      system.addColorGradient(
        gradient,
        new Color4(color.r, color.g, color.b, color.a),
      );
    },
    addSizeGradient: (gradient, factor) => {
      system.addSizeGradient(gradient, factor);
    },
    addAngularSpeedGradient: (gradient, factor) => {
      system.addAngularSpeedGradient?.(gradient, factor);
    },
    addDragGradient: (gradient, factor) => {
      system.addDragGradient?.(gradient, factor);
    },
    createPointEmitter: (direction1, direction2) =>
      system.createPointEmitter(vec3(direction1), vec3(direction2)),
    createBoxEmitter: (direction1, direction2, min, max) =>
      system.createBoxEmitter(
        vec3(direction1),
        vec3(direction2),
        vec3(min),
        vec3(max),
      ),
    createSphereEmitter: (radius, radiusRange) =>
      system.createSphereEmitter(radius, radiusRange),
    createConeEmitter: (radius, angle) =>
      system.createConeEmitter(radius, angle),
  };
}

export function applyParticleLook(options: {
  system: IParticleSystem;
  emitter: ParticleEmitterPayload;
  systemPayload: ParticleSystemPayload;
  gpu: boolean;
  texture: Texture | null;
  material: NodeMaterial | null;
}): Promise<void> | null {
  const applied = applyParticleEmitterPayload(
    options.emitter,
    bindParticleApplyTarget(options.system),
    {
      space: options.systemPayload.space,
      looping: options.systemPayload.looping,
      duration: options.systemPayload.duration,
      gpuSupported: options.gpu,
    },
  );
  void applied;
  if (options.texture) {
    options.system.particleTexture = options.texture;
  }
  pendingParticleMaterials.get(options.system)?.();
  if (options.material && options.material.mode === NodeMaterialModes.Particle) {
    if (options.texture) {
      bindParticleTextureBlocks(options.material, options.texture);
    }
    const ready = bindReadyParticleMaterial(options.system, options.material);
    if (options.texture) {
      options.system.particleTexture = options.texture;
    }
    return ready;
  }
  return null;
}

const pendingParticleMaterials = new WeakMap<IParticleSystem, () => void>();

function bindReadyParticleMaterial(system: IParticleSystem, material: NodeMaterial): Promise<void> {
  const scene = system.getScene();
  if (!scene) throw new Error("Particle materials require an owning scene.");
  if (isDisposedNodeMaterial(material, scene)) throw new Error("Particle material requires its live owning scene.");
  const readiness = { isReady: () => false };
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Existing standalone factory consumers may leave preparation to scene readiness.
  // The returned promise still rejects for an owning service to diagnose and retire.
  void ready.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
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
  timer = setTimeout(() => fail(new Error("Particle material preparation timed out.")), SCENE_SHADER_WARM_TIMEOUT_MS);
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

function bindParticleTextureBlocks(
  material: NodeMaterial,
  texture: Texture,
): void {
  for (const block of material.attachedBlocks ?? []) {
    if (block instanceof ParticleTextureBlock) {
      block.texture = texture;
    }
  }
}

export function particleCapacityFor(
  emitter: ParticleEmitterPayload,
  gpu: boolean,
): number {
  return resolveParticleEmitterCapacity(emitter.capacity, gpu);
}

import {
  Color4,
  GPUParticleSystem,
  NodeMaterialModes,
  ParticleSystem,
  Vector3,
  type IParticleSystem,
  type NodeMaterial,
  type Scene,
  type Texture,
} from "@babylonjs/core";
import {
  applyParticleEmitterPayload,
  resolveParticleEmitterCapacity,
  type ParticleApplyTarget,
  type ParticleEmitterPayload,
  type ParticleSystemPayload,
} from "@babylonslate/assets";

export function gpuParticlesSupported(requested = true): boolean {
  return requested && GPUParticleSystem.IsSupported === true;
}

export function createBabylonParticleSystem(
  name: string,
  scene: Scene,
  capacity: number,
  gpu: boolean,
): IParticleSystem {
  if (gpu) {
    return new GPUParticleSystem(name, { capacity }, scene);
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
}): void {
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
  if (options.material && options.material.mode === NodeMaterialModes.Particle) {
    options.material.createEffectForParticles(options.system);
    if (options.texture) {
      options.system.particleTexture = options.texture;
    }
  }
}

export function particleCapacityFor(
  emitter: ParticleEmitterPayload,
  gpu: boolean,
): number {
  return resolveParticleEmitterCapacity(emitter.capacity, gpu);
}

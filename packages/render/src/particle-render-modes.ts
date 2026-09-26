import { ParticleSystem } from "@babylonjs/core";
import type { ParticleBillboardMode, ParticleBlendMode } from "@babylonslate/core";

/**
 * The one numeric mapping for particle Blend Mode and Billboard ids. Documents store
 * only the string ids; Babylon's constants are read by name so a Babylon upgrade can
 * never swap them (docs/design/particle-emitters.md D7). Shared by the Basic apply and
 * Particle Graph lowering.
 */
export const PARTICLE_BLEND_MODES: Readonly<Record<ParticleBlendMode, number>> = {
  additive: ParticleSystem.BLENDMODE_ONEONE,
  standard: ParticleSystem.BLENDMODE_STANDARD,
  add: ParticleSystem.BLENDMODE_ADD,
  multiply: ParticleSystem.BLENDMODE_MULTIPLY,
  subtract: ParticleSystem.BLENDMODE_SUBTRACT,
};

/** All particles are billboarded quads; Stretched aligns the quad's Y axis to velocity. */
export const PARTICLE_BILLBOARD_MODES: Readonly<Record<ParticleBillboardMode, number>> = {
  all: ParticleSystem.BILLBOARDMODE_ALL,
  y: ParticleSystem.BILLBOARDMODE_Y,
  stretched: ParticleSystem.BILLBOARDMODE_STRETCHED,
};

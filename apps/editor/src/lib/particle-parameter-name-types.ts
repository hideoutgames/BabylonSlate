/** Particle parameter nodes whose Name pin lists the Self actor's parameters, with the value types each one takes. */
export const PARTICLE_PARAMETER_NAME_TYPES: Readonly<Record<string, readonly string[] | null>> = {
  "particles.setFloatParameter": ["float"],
  "particles.getFloatParameter": ["float"],
  "particles.setVectorParameter": ["vec2", "vec3"],
  "particles.getVectorParameter": ["vec2", "vec3"],
  "particles.setColorParameter": ["color"],
  "particles.getColorParameter": ["color"],
  "particles.resetParameter": null,
};

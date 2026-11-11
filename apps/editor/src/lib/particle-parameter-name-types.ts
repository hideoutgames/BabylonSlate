/** Particle component parameter functions, by runtime name, with the value types each one's Name lists (`null`: every type). */
const PARTICLE_PARAMETER_FUNCTION_TYPES: Readonly<Record<string, readonly string[] | null>> = {
  setParticleFloatParameter: ["float"],
  getParticleFloatParameter: ["float"],
  setParticleVector2Parameter: ["vec2"],
  getParticleVector2Parameter: ["vec2"],
  setParticleVector3Parameter: ["vec3"],
  getParticleVector3Parameter: ["vec3"],
  setParticleColorParameter: ["color"],
  getParticleColorParameter: ["color"],
  resetParticleParameter: null,
};

/**
 * The parameter types a node's Name pin lists when the node calls a Particle component's
 * parameter function (`null`: every type), or `undefined` for any other node.
 */
export function particleParameterNameTypes(
  nodeType: string | undefined,
  nodeData: Readonly<Record<string, unknown>>,
): readonly string[] | null | undefined {
  if (nodeType !== "functions.call" || nodeData.classId !== "ParticleComponent") return undefined;
  const runtime = typeof nodeData.runtime === "string" ? nodeData.runtime : "";
  return Object.hasOwn(PARTICLE_PARAMETER_FUNCTION_TYPES, runtime) ? PARTICLE_PARAMETER_FUNCTION_TYPES[runtime] : undefined;
}

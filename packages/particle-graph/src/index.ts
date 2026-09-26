/**
 * Particle Graph IR: the saved document, node catalog, type rules, validation,
 * lowering to a Babylon-free build plan and the canvas adapter. React-free and
 * Babylon-free; `@babylonslate/render` realizes the plan on Node Particle blocks.
 */
export {
  PARTICLE_CATALOG,
  PARTICLE_CONDITION_TESTS,
  PARTICLE_OUTPUT_NODE_TYPE,
  PARTICLE_PALETTE_CATEGORIES,
  PARTICLE_RANDOM_LOCKS,
  PARTICLE_UNSUPPORTED_V1_TYPES,
  PARTICLE_VALUE_TYPE_OPTIONS,
  isParticleSpineRole,
  particleNodeDefinition,
  particleNodeDefinitionFor,
  particleNodeValueType,
  particleNodeValueTypeDefault,
  particlePaletteEntries,
  type ParticleConditionTest,
  type ParticleNodeDefinition,
  type ParticleNodeRole,
  type ParticlePinDefinition,
  type ParticlePinType,
  type ParticleRandomLock,
} from "./catalog";
export {
  PARTICLE_GRAPH_LIMITS,
  PARTICLE_GRAPH_SCHEMA_VERSION,
  createDefaultParticleGraphDocument,
  createDefaultParticleGraphSettings,
  newParticleNodeProperties,
  normalizeParticleGraphDocument,
  normalizeParticleGraphSettings,
  normalizeParticleNodeProperties,
  particleGraphDependencies,
  setParticleNodeValueType,
  type ParticleGraphDependencies,
  type ParticleGraphDocument,
  type ParticleGraphEdge,
  type ParticleGraphNode,
  type ParticleGraphSettings,
} from "./document";
export {
  canonicalParticleGradientStops,
  defaultParticleGradientStops,
  particleGradientStops,
  type ParticleGradientStop,
} from "./gradient";
export {
  lowerParticleGraphDocument,
  particleGraphCompileKey,
  type ParticleBuildPlan,
  type ParticleGraphLowerContext,
  type ParticleGraphLowerResult,
  type ParticleOperand,
  type ParticleOperation,
} from "./lower";
export {
  clampParticlePinValue,
  listUnconnectedParticlePinDefaults,
  particlePinDefaultPropertyKey,
  readParticlePinDefault,
  resolveParticlePinDefault,
  type ParticlePinDefault,
} from "./pin-defaults";
export {
  createParticleTypeResolver,
  particleGenericGroup,
  type ParticleTypeResolver,
} from "./resolve";
export {
  hydrateParticleGraphForEditor,
  particleConnectionIsAllowed,
  particleGraphToSerialized,
  particleNodePropertiesFromData,
  particleNodeRole,
  particlePaletteNodes,
  particlePinsAreCompatible,
  pinsForParticleNode,
  serializedToParticleGraph,
  type ParticleGraphPin,
  type ParticlePaletteNode,
} from "./serialize-particle-graph";
export {
  PARTICLE_NUMERIC_TYPES,
  isParticleNumericType,
  particleComponentCount,
  particleConversionFor,
  particleTypeLabel,
  particleTypesAreAssignable,
  resizeParticleValue,
  resolveParticleGenericType,
  type ParticleConversion,
  type ParticleGenericResolution,
  type ParticleNumericType,
  type ParticleValueType,
} from "./types";
export {
  findParticleGraphCycle,
  particleSpine,
  validateParticleGraphDocument,
  type ParticleDiagnosticSeverity,
  type ParticleGraphDiagnostic,
  type ParticleGraphValidationContext,
} from "./validate";

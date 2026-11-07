/**
 * Particle Graph IR: the saved document, node catalog, type rules, validation,
 * lowering to a Babylon-free build plan and the canvas adapter. React-free and
 * Babylon-free; `@haptic/render` realizes the plan on Node Particle blocks.
 */
export {
  PARTICLE_ANGLE_UNIT_OPTIONS,
  PARTICLE_CATALOG,
  PARTICLE_CONDITION_TESTS,
  PARTICLE_LOCAL_VARIABLE_SCOPES,
  PARTICLE_MESH_SHAPE_SOURCES,
  PARTICLE_OUTPUT_NODE_TYPE,
  PARTICLE_PARAMETER_NODE_TYPE,
  PARTICLE_RANDOM_LOCKS,
  PARTICLE_UNSUPPORTED_V1_TYPES,
  PARTICLE_VALUE_TYPE_OPTIONS,
  particleNodeAngleUnit,
  particleNodeDefinitionFor,
  particleNodeValueType,
  type ParticleAngleUnit,
  type ParticleConditionTest,
  type ParticleLocalVariableScope,
  type ParticleMeshShapeSource,
  type ParticleNodeDefinition,
  type ParticleNodeRole,
  type ParticlePinDefinition,
  type ParticlePinType,
  type ParticleRandomLock,
} from "./catalog";
export {
  PARTICLE_GRAPH_LIMITS,
  PARTICLE_SPRITE_SHEET_LIMITS,
  createDefaultParticleGraphDocument,
  createDefaultParticleGraphSettings,
  newParticleNodeProperties,
  normalizeParticleGraphDocument,
  normalizeParticleGraphSettings,
  normalizeParticleParameterName,
  particleGraphDependencies,
  particleGraphMeshModels,
  particleGraphNoiseTextures,
  particleSpriteSheetSettings,
  setParticleNodeAngleUnit,
  setParticleNodeValueType,
  type ParticleGraphDependencies,
  type ParticleGraphDocument,
  type ParticleGraphEdge,
  type ParticleGraphNode,
  type ParticleGraphParameter,
  type ParticleGraphSettings,
  type ParticleSpriteSheetSettings,
} from "./document";
export {
  PARTICLE_SPAWN_LIMITS,
  PARTICLE_SPAWN_PRESETS,
  particleGraphSpawnEmitters,
  particleSpawnSettings,
  withParticleSpawnPreset,
  type ParticleSpawnPreset,
  type ParticleSpawnSettings,
} from "./spawn";
export {
  particleGradientStops,
  type ParticleGradientStop,
} from "./gradient";
export {
  lowerParticleGraphDocument,
  lowerParticleGraphDocumentCached,
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
  type ParticlePinDefault,
} from "./pin-defaults";
export type {
  ParticleTypeResolver,
} from "./resolve";
export {
  convertParticleConstantToParameter,
  convertParticleParameterToConstant,
  particleConstantValueType,
  reconcileParticleParameters,
  uniqueParticleParameterName,
  withParticleParameter,
  type ParticleParameterSnapshot,
} from "./parameter-nodes";
export {
  hydrateParticleGraphForEditor,
  particleConnectionIsAllowed,
  particleGraphToSerialized,
  particlePaletteNodes,
  particleParameterSnapshots,
  particlePinsAreCompatible,
  serializedToParticleGraph,
  type ParticleGraphPin,
  type ParticlePaletteNode,
} from "./serialize-particle-graph";
export {
  resizeParticleValue,
  type ParticleConversion,
  type ParticleGenericResolution,
  type ParticleNumericType,
  type ParticleValueType,
} from "./types";
export {
  validateParticleGraphDocument,
  type ParticleDiagnosticSeverity,
  type ParticleGraphDiagnostic,
  type ParticleGraphValidationContext,
} from "./validate";
export * from "./global-parameter";

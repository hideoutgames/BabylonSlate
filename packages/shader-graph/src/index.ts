export {
  MATERIAL_CATALOG,
  materialNodeDefinition,
  type MaterialCapability,
  parseMaterialDomain,
  type MaterialDomain,
  type MaterialNodeDefinition,
  type MaterialPinDefinition,
  type MaterialPinType,
  type MaterialStage,
} from "./catalog";
export {
  MATERIAL_PREVIEW_MESHES,
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  createImportedMaterialDocument,
  materialDependencies,
  missingPackedMaterialTextureGuids,
  normalizeMaterialDocument,
  normalizeMaterialFunctionDocument,
  setMaterialDomain,
  type MaterialBlendMode,
  type MaterialDependencies,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialFunctionPin,
  type MaterialGraphEdge,
  type MaterialGraphNode,
  type MaterialPreviewMesh,
  type MaterialPreviewSettings,
  type MaterialShadingModel,
} from "./document";
export {
  lowerMaterialDocument,
  lowerMaterialDocumentCached,
  materialCompileKeyFromLowering,
  type MaterialBuildPlan,
  type MaterialBufferRequirements,
  type MaterialCostFeatures,
  type MaterialLowerContext,
  type MaterialLowerResult,
  type MaterialOperand,
  type MaterialOperation,
  type MaterialOperationSource,
  type MaterialTextureBinding,
  type MaterialTextureFilter,
} from "./lower";
export { createWaterMaterialDocument } from "./water-materials";
export type { TypeResolver } from "./resolve";
export {
  hydrateMaterialGraphForEditor,
  materialGraphToSerialized,
  materialAddNodePalette,
  materialPaletteNodes,
  materialPinsAreCompatible,
  pinsForMaterialNode,
  serializedToMaterialFunctionGraph,
  serializedToMaterialGraph,
  type MaterialGraphPin,
  type MaterialPaletteNode,
  type MaterialPinContext,
} from "./serialize-material";
export {
  asNumberArray,
  listUnconnectedMaterialPinDefaults,
  materialPinDefaultPropertyKey,
  type MaterialPinDefault,
  type MaterialPinDefaultContext,
} from "./pin-defaults";
export {
  componentCount,
  type MaterialConversion,
  type MaterialNumericType,
  type MaterialValueType,
} from "./types";
export {
  validateMaterialDocument,
  validateMaterialFunctionDocument,
  type MaterialCapabilities,
  type MaterialDiagnostic,
  type MaterialDiagnosticSeverity,
  type MaterialValidationContext,
} from "./validate";
export {
  classifyMaterialCost,
  materialPreviewReducer,
  createMaterialPreviewState,
  renderActionEnabled,
  type MaterialCostClass,
  type MaterialPreviewEvent,
  type MaterialPreviewPolicy,
  type MaterialPreviewState,
  type MaterialPreviewStatus,
} from "./preview-state";
export { isMaterialParameterNode, isPerInstanceParameter, materialParameterName, validateMaterialParameterNames } from "./parameters";
export {
  canConvertMaterialConstantToParameter,
  canConvertMaterialParameterToConstant,
  convertMaterialConstantToParameter,
  convertMaterialParameterToConstant,
  materialParameterValueType,
  nameNewMaterialParameters,
  renameMaterialParameter,
  retypeMaterialParameter,
  type MaterialParameterValueType,
} from "./parameter-authoring";
export { customGlslInterface, customGlslInterfaceError, newCustomGlslProperties, type CustomGlslPin } from "./custom-glsl";
export { materialGradientStops, type MaterialGradientStop } from "./gradient";
export * from "./vector-mask";
export * from "./global-parameter";

export { buildMaterialParameterCatalog, materialParameterDefaults } from "./material-parameter-catalog";
export { convertGlslToMaterial, type GlslToMaterialOptions, type GlslToMaterialResult } from "./glsl-to-material";
export {
  MATERIAL_INSTANCE_MAX_DEPTH,
  createDefaultMaterialInstanceDocument,
  isMaterialInstanceContent,
  materialInstanceDependencies,
  materializeMaterialInstance,
  materializeMaterialInstances,
  normalizeMaterialInstanceDocument,
  resolveMaterialInstance,
  type MaterialInstanceDocument,
  type MaterialInstanceResolution,
  type MaterialSource,
} from "./material-instance";

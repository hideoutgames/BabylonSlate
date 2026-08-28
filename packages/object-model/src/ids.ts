/** Stable engine base class ids (Content Browser / class registry). */
export const ENGINE_BASE_CLASS_IDS = [
  "BObject",
  "Actor",
  "Scene",
  "SceneLayer",
  "SceneLayerActor",
  "ActorComponent",
  "GameInstance",
  "FunctionLibrary",
  "BDebugCommand",
  "EditorUtilityObject",
  "EditorFunctionLibrary",
  "BTTask",
  "BTDecorator",
  "BTService",
  "BTComposite",
] as const;

export type EngineBaseClassId = (typeof ENGINE_BASE_CLASS_IDS)[number];

/** Engine component class ids registered from P3 (behaviour filled later). */
export const ENGINE_COMPONENT_CLASS_IDS = [
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "CameraComponent",
  "LightComponent",
  "HemisphericFillLightComponent",
  "SkyboxComponent",
  "Text3DComponent",
  "AudioComponent",
  "ParticleComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "AnimationGraphComponent",
  "BehaviourTreeComponent",
  "NavAgentComponent",
  "NavMeshComponent",
  "NavMeshBlockerComponent",
  "BlockingVolumeComponent",
  "2DAnchorComponent",
  "2DButtonComponent",
  "2DMaterialComponent",
  "2DTextureComponent",
  "2DTextComponent",
  "2DRichTextComponent",
  "2DPanelComponent",
] as const;

export type EngineComponentClassId =
  (typeof ENGINE_COMPONENT_CLASS_IDS)[number];

export const SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS = [
  "2DAnchorComponent",
  "2DButtonComponent",
  "2DMaterialComponent",
  "2DTextureComponent",
  "2DTextComponent",
  "2DRichTextComponent",
  "2DPanelComponent",
] as const;

export type SceneLayerExclusiveComponentClassId =
  (typeof SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS)[number];

const SCENE_LAYER_DENIED_COMPONENTS = new Set([
  "SkyboxComponent",
  "CameraComponent",
  "LightComponent",
  "HemisphericFillLightComponent",
]);

export function isSceneLayerAllowedComponent(classId: string): boolean {
  return !SCENE_LAYER_DENIED_COMPONENTS.has(classId);
}

export function isSceneLayerExclusiveComponent(classId: string): boolean {
  return (SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS as readonly string[]).includes(
    classId,
  );
}

/** Live Scene instance class id for a Content Browser Scene asset. */
export function sceneAssetClassId(assetGuid: string): string {
  return `Scene:${assetGuid}`;
}

export function isSceneAssetClassId(classId: string): boolean {
  return classId === "Scene" || classId.startsWith("Scene:");
}
export function isLockedEngineClassId(classId: string): boolean {
  if ((ENGINE_BASE_CLASS_IDS as readonly string[]).includes(classId)) {
    return true;
  }
  if ((ENGINE_COMPONENT_CLASS_IDS as readonly string[]).includes(classId)) {
    return true;
  }
  return ENGINE_BT_BUILTIN_CLASSES.some((entry) => entry.id === classId);
}

/** Built-in behaviour-tree classes users can inherit (engineplan §14.1). */
export const ENGINE_BT_BUILTIN_CLASSES = [
  { id: "BTTask_Wait", parentClassId: "BTTask" },
  { id: "BTTask_MoveTo", parentClassId: "BTTask" },
  { id: "BTTask_RotateToFace", parentClassId: "BTTask" },
  { id: "BTTask_PlayAnimation", parentClassId: "BTTask" },
  { id: "BTTask_PlaySound", parentClassId: "BTTask" },
  { id: "BTTask_SetBlackboardValue", parentClassId: "BTTask" },
  { id: "BTDecorator_Loop", parentClassId: "BTDecorator" },
  { id: "BTDecorator_Cooldown", parentClassId: "BTDecorator" },
  { id: "BTDecorator_TimeLimit", parentClassId: "BTDecorator" },
  { id: "BTDecorator_BlackboardIsSet", parentClassId: "BTDecorator" },
  { id: "BTDecorator_CompareBlackboardValue", parentClassId: "BTDecorator" },
  { id: "BTService_SetBlackboardValue", parentClassId: "BTService" },
  { id: "BTComposite_Selector", parentClassId: "BTComposite" },
  { id: "BTComposite_Sequence", parentClassId: "BTComposite" },
  { id: "BTComposite_Parallel", parentClassId: "BTComposite" },
] as const;

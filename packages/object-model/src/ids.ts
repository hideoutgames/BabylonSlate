/** Stable engine base class ids (Content Browser / class registry). */
export const ENGINE_BASE_CLASS_IDS = [
  "BObject",
  "Actor",
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
] as const;

export type EngineComponentClassId =
  (typeof ENGINE_COMPONENT_CLASS_IDS)[number];

/** Engine types that must not be reparented (bases, components, BT builtins). */
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

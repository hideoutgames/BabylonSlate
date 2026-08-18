import {
  ENGINE_WIDGET_KINDS,
  USER_INTERFACE_ENGINE_CLASS_ID,
  WIDGET_ENGINE_CLASS_ID,
  userInterfaceClassId,
  widgetClassIdForKind,
} from "@babylonslate/core";

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
  USER_INTERFACE_ENGINE_CLASS_ID,
  WIDGET_ENGINE_CLASS_ID,
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
  "AudioComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "WidgetComponent",
  "AnimationGraphComponent",
  "BehaviourTreeComponent",
  "NavAgentComponent",
  "NavMeshComponent",
  "NavMeshBlockerComponent",
] as const;

export type EngineComponentClassId =
  (typeof ENGINE_COMPONENT_CLASS_IDS)[number];

/** Concrete Widget subclasses, one per authored widget kind. */
export const ENGINE_WIDGET_CLASS_IDS = ENGINE_WIDGET_KINDS.map((kind) =>
  widgetClassIdForKind(kind),
);

/** Engine types that must not be reparented (bases, components, BT builtins). */
export function isLockedEngineClassId(classId: string): boolean {
  if ((ENGINE_BASE_CLASS_IDS as readonly string[]).includes(classId)) {
    return true;
  }
  if ((ENGINE_COMPONENT_CLASS_IDS as readonly string[]).includes(classId)) {
    return true;
  }
  if (ENGINE_WIDGET_CLASS_IDS.includes(classId)) {
    return true;
  }
  return ENGINE_BT_BUILTIN_CLASSES.some((entry) => entry.id === classId);
}

/** ClassDef fields for a project UserInterface asset. Runtime registers these later. */
export function userInterfaceAssetClassDef(assetGuid: string): {
  id: string;
  parentClassId: typeof USER_INTERFACE_ENGINE_CLASS_ID;
  kind: "object";
  variables: [];
  implementedInterfaces: [];
} {
  return {
    id: userInterfaceClassId(assetGuid),
    parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
    kind: "object",
    variables: [],
    implementedInterfaces: [],
  };
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

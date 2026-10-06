import {
  ENGINE_COMPONENT_CLASS_IDS,
  SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS,
  isSceneLayerDeniedComponent,
  type EngineComponentClassId,
} from "@babylonslate/core";

export { ENGINE_COMPONENT_CLASS_IDS, SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS };
export type { EngineComponentClassId };

/** Hidden abstract base of both subsystem kinds; never user-selectable or instantiated. */
export const SUBSYSTEM_CLASS_ID = "Subsystem";
/** Session-lifetime subsystem base users can parent to. */
export const GAME_SUBSYSTEM_CLASS_ID = "GameSubsystem";
/** Main-scene-lifetime subsystem base users can parent to. */
export const SCENE_SUBSYSTEM_CLASS_ID = "SceneSubsystem";

/** Stable engine base class ids (Content Browser / class registry). */
export const ENGINE_BASE_CLASS_IDS = [
  "BObject",
  "MaterialObject",
  "Actor",
  "RenderTargetCapture",
  "Scene",
  "SceneLayer",
  "SceneLayerActor",
  "SceneLayerActorSwitcher",
  "SceneStreamingActor",
  "ActorComponent",
  "GameInstance",
  SUBSYSTEM_CLASS_ID,
  GAME_SUBSYSTEM_CLASS_ID,
  SCENE_SUBSYSTEM_CLASS_ID,
  "FunctionLibrary",
  "BDebugCommand",
  "EditorUtilityObject",
  "EditorFunctionLibrary",
  "BTTask",
  "BTDecorator",
  "BTService",
  "BTComposite",
] as const;

/**
 * Engine bases that stay locked and known to validation but are never offered
 * in parent, type or Cast pickers.
 */
export const HIDDEN_ENGINE_BASE_CLASS_IDS = [SUBSYSTEM_CLASS_ID] as const;

export function isHiddenEngineBaseClassId(classId: string): boolean {
  return (HIDDEN_ENGINE_BASE_CLASS_IDS as readonly string[]).includes(classId);
}

export function isSceneLayerAllowedComponent(classId: string): boolean {
  return !isSceneLayerDeniedComponent(classId);
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
  { id: "BTTask_MoveToBlackboardKey", parentClassId: "BTTask" },
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

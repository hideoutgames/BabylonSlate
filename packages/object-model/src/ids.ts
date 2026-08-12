/** Stable engine base class ids (Content Browser / class registry). */
export const ENGINE_BASE_CLASS_IDS = [
  "BObject",
  "Actor",
  "ActorComponent",
  "GameInstance",
  "FunctionLibrary",
] as const;

export type EngineBaseClassId = (typeof ENGINE_BASE_CLASS_IDS)[number];

/** Engine component class ids registered from P3 (behaviour filled later). */
export const ENGINE_COMPONENT_CLASS_IDS = [
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "CameraComponent",
  "LightComponent",
  "AudioComponent",
  "RigidBodyComponent",
  "ColliderComponent",
  "WidgetComponent",
  "BehaviourTreeComponent",
  "NavAgentComponent",
] as const;

export type EngineComponentClassId =
  (typeof ENGINE_COMPONENT_CLASS_IDS)[number];

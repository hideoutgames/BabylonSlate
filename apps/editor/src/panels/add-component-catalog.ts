import type { PhysicsWorldKind } from "@babylonslate/core";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
} from "@babylonslate/physics";

export const ADDABLE_COMPONENT_CLASSES = [
  {
    id: "MeshComponent",
    label: "Mesh",
    description: "Renderable primitive",
    category: "Rendering",
  },
  {
    id: "SpriteComponent",
    label: "Sprite",
    description: "2D sprite quad",
    category: "Rendering",
  },
  {
    id: "AnimationGraphComponent",
    label: "Animation Graph",
    description: "Worker-evaluated clip state machine",
    category: "Animation",
  },
  {
    id: "LightComponent",
    label: "Light",
    description: "Scene light",
    category: "Rendering",
  },
  {
    id: "CameraComponent",
    label: "Camera",
    description: "Scene camera",
    category: "Camera",
  },
  {
    id: "RigidBodyComponent",
    label: "Rigid Body",
    description: "Physics body",
    category: "Physics",
  },
  {
    id: "ColliderComponent",
    label: "Collider",
    description: "Physics collider",
    category: "Physics",
  },
] as const;

export function defaultPropertiesFor(
  classId: string,
  physicsWorld: PhysicsWorldKind = "3d",
): Record<string, unknown> {
  switch (classId) {
    case "MeshComponent":
      return { meshKind: "box", assetGuid: null };
    case "SpriteComponent":
      return { assetGuid: null, sortingLayer: "Default", orderInLayer: 0 };
    case "WidgetComponent":
      return { uiAssetGuid: null, viewportLayer: false };
    case "AnimationGraphComponent":
      return { graphGuid: null };
    case "CameraComponent":
      return { fieldOfView: 60, orthographicSize: 5 };
    case "LightComponent":
      return { intensity: 1, color: [1, 1, 1] };
    case "RigidBodyComponent":
      return { ...parseRigidBodyProperties({}) };
    case "ColliderComponent":
      return { ...parseColliderProperties({}, physicsWorld) };
    default:
      return {};
  }
}

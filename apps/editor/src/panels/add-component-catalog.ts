import type { PhysicsWorldKind } from "@babylonslate/core";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
} from "@babylonslate/physics";

export const ADDABLE_COMPONENT_CLASSES = [
  { id: "MeshComponent", label: "Mesh", description: "Renderable primitive" },
  { id: "SpriteComponent", label: "Sprite", description: "2D sprite" },
  { id: "CameraComponent", label: "Camera", description: "Scene camera" },
  { id: "LightComponent", label: "Light", description: "Scene light" },
  { id: "RigidBodyComponent", label: "Rigid Body", description: "Physics body" },
  {
    id: "ColliderComponent",
    label: "Collider",
    description: "Physics collider",
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

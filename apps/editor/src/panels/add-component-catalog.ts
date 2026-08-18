import type { PhysicsWorldKind, ViewportMode } from "@babylonslate/core";
import { emptySkyboxFaces } from "@babylonslate/core";
import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
} from "@babylonslate/core";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
} from "@babylonslate/physics";
import {
  DEFAULT_NAV_AGENT_PARAMS,
  defaultNavMeshBlockerComponentProperties,
  defaultNavMeshComponentProperties,
} from "@babylonslate/navigation";

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
    id: "TilemapComponent",
    label: "Tilemap",
    description: "Chunked 2D tilemap",
    category: "Rendering",
  },
  {
    id: "AnimationGraphComponent",
    label: "Animation Graph",
    description: "Worker-evaluated clip state machine",
    category: "Animation",
  },
  {
    id: "BehaviourTreeComponent",
    label: "Behaviour Tree",
    description: "Worker-evaluated behaviour tree",
    category: "AI",
  },
  {
    id: "NavAgentComponent",
    label: "Nav Agent",
    description: "Crowd agent on the baked navmesh",
    category: "AI",
  },
  {
    id: "LightComponent",
    label: "Light",
    description: "Scene light",
    category: "Rendering",
  },
  {
    id: "SkyboxComponent",
    label: "Skybox",
    description: "Cubemap sky surrounding the scene",
    category: "Rendering",
  },
  {
    id: "CameraComponent",
    label: "Camera",
    description: "Scene camera",
    category: "Camera",
  },
  {
    id: "AudioComponent",
    label: "Audio",
    description: "Plays an Audio asset",
    category: "Audio",
  },
  {
    id: "ParticleComponent",
    label: "Particle",
    description: "Plays a Particle System",
    category: "Particles",
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
  viewportMode: ViewportMode = "3d",
): Record<string, unknown> {
  switch (classId) {
    case "MeshComponent":
      return { meshKind: "box", assetGuid: null };
    case "SpriteComponent":
      return { assetGuid: null, sortingLayer: "Default", orderInLayer: 0 };
    case "TilemapComponent":
      return { assetGuid: null, sortingLayer: "Default", orderInLayer: 0 };
    case "WidgetComponent":
      return { uiAssetGuid: null, viewportLayer: false };
    case "AnimationGraphComponent":
      return { graphGuid: null };
    case "BehaviourTreeComponent":
      return { treeGuid: null, blackboardGuid: null };
    case "NavAgentComponent":
      return { ...DEFAULT_NAV_AGENT_PARAMS };
    case "NavMeshComponent":
      return { ...defaultNavMeshComponentProperties() };
    case "NavMeshBlockerComponent":
      return { ...defaultNavMeshBlockerComponentProperties() };
    case "CameraComponent":
      return {
        fieldOfView: DEFAULT_CAMERA_FIELD_OF_VIEW,
        orthographicSize: DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
        projectionMode: viewportMode === "2d" ? "orthographic" : "perspective",
        nearClip: 0.1,
        farClip: 1000,
        attemptPossessViewTarget: false,
      };
    case "LightComponent":
      return {
        intensity: 1,
        color: [1, 1, 1],
        lightKind: "point",
        range: 10,
        outerAngle: 45,
        innerAngle: 30,
        enabled: true,
        castShadows: false,
      };
    case "SkyboxComponent":
      return { size: 1000, faces: emptySkyboxFaces() };
    case "AudioComponent":
      return {
        audioAssetGuid: null,
        playOnStart: true,
        loop: false,
        volume: 1,
      };
    case "ParticleComponent":
      return {
        particleSystemGuid: null,
        playOnStart: true,
        sortingLayer: "Default",
        orderInLayer: 0,
      };
    case "RigidBodyComponent":
      return { ...parseRigidBodyProperties({}) };
    case "ColliderComponent":
      return { ...parseColliderProperties({}, physicsWorld) };
    default:
      return {};
  }
}

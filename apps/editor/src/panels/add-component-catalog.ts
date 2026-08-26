import type {
  PhysicsWorldKind,
  SerializedScene,
  ViewportMode,
} from "@babylonslate/core";
import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  emptySkyboxFaces,
  parseText3DProperties,
  parseText2DProperties,
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
import { humanizePropertyLabel, walkAncestry } from "@babylonslate/editor-kit";
import { isLockedEngineClassId, isSceneLayerAllowedComponent, isSceneLayerExclusiveComponent } from "@babylonslate/object-model";
import {
  classIdFromClassAsset,
  classParentLookup,
} from "../lib/content-browser-helpers";

export type AddComponentItem = {
  id: string;
  classId: string;
  label: string;
  description: string;
  category: string;
  properties?: Record<string, unknown>;
};

export type AddComponentSelection = {
  classId: string;
  properties?: Record<string, unknown>;
};

function engineComponent(
  id: string,
  label: string,
  description: string,
  category: string,
): AddComponentItem {
  return { id, classId: id, label, description, category };
}

export const ADDABLE_COMPONENT_CLASSES: readonly AddComponentItem[] = [
  engineComponent(
    "MeshComponent",
    "Mesh",
    "Primitive or Model asset",
    "Rendering",
  ),
  engineComponent("SpriteComponent", "Sprite", "2D sprite quad", "Rendering"),
  engineComponent(
    "TilemapComponent",
    "Tilemap",
    "Chunked 2D tilemap",
    "Rendering",
  ),
  engineComponent(
    "AnimationGraphComponent",
    "Animation Graph",
    "Worker-evaluated clip state machine",
    "Animation",
  ),
  engineComponent(
    "BehaviourTreeComponent",
    "Behaviour Tree",
    "Worker-evaluated behaviour tree",
    "AI",
  ),
  engineComponent(
    "NavAgentComponent",
    "Nav Agent",
    "Crowd agent on the baked navmesh",
    "AI",
  ),
  engineComponent("LightComponent", "Light", "Scene light", "Rendering"),
  engineComponent(
    "SkyboxComponent",
    "Skybox",
    "Cubemap sky surrounding the scene",
    "Rendering",
  ),
  engineComponent(
    "Text3DComponent",
    "3D Text",
    "Extruded world-space text",
    "Rendering",
  ),
  engineComponent("CameraComponent", "Camera", "Scene camera", "Camera"),
  engineComponent(
    "AudioComponent",
    "Audio",
    "Plays an Audio asset",
    "Audio",
  ),
  engineComponent(
    "ParticleComponent",
    "Particle",
    "Plays a Particle System",
    "Particles",
  ),
  engineComponent(
    "2DAnchorComponent",
    "2D Anchor",
    "Pins an overlay actor to a SceneLayer edge or center",
    "Overlay",
  ),
  engineComponent(
    "2DButtonComponent",
    "2D Button",
    "Pointer enter, leave, click, and press events",
    "Overlay",
  ),
  engineComponent(
    "2DMaterialComponent",
    "2D Material",
    "Unlit plane shaded by a surface Material",
    "Overlay",
  ),
  engineComponent(
    "2DTextureComponent",
    "2D Texture",
    "Unlit plane shaded by a Texture",
    "Overlay",
  ),
  engineComponent(
    "2DTextComponent",
    "2D Text",
    "Overlay bitmap or MSDF text from a Font",
    "Overlay",
  ),
  engineComponent(
    "2DRichTextComponent",
    "2D Rich Text",
    "Overlay text with markup, images, and letter effects",
    "Overlay",
  ),
  engineComponent(
    "RigidBodyComponent",
    "Rigid Body",
    "Physics body",
    "Physics",
  ),
  engineComponent(
    "ColliderComponent",
    "Collider",
    "Physics collider",
    "Physics",
  ),
];

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
    case "BlockingVolumeComponent":
      return {};
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
    case "Text3DComponent":
      return { ...parseText3DProperties({}) };
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
    case "2DAnchorComponent":
      return { anchor: "center", offsetX: 0, offsetY: 0 };
    case "2DButtonComponent":
      return { hitTest: "block" };
    case "2DMaterialComponent":
      return { materialGuid: null, hitTest: "ignore" };
    case "2DTextureComponent":
      return { textureGuid: null, hitTest: "ignore" };
    case "2DTextComponent":
      return { ...parseText2DProperties({}) };
    case "2DRichTextComponent":
      return { ...parseText2DProperties({}, { rich: true }) };
    case "RigidBodyComponent":
      return { ...parseRigidBodyProperties({}) };
    case "ColliderComponent":
      return { ...parseColliderProperties({}, physicsWorld) };
    default:
      return {};
  }
}

export function addableComponentsForHost(options: {
  overlay: boolean;
}): AddComponentItem[] {
  return ADDABLE_COMPONENT_CLASSES.filter((entry) => {
    if (options.overlay) {
      return isSceneLayerAllowedComponent(entry.classId);
    }
    return !isSceneLayerExclusiveComponent(entry.classId);
  });
}

const PROJECT_ASSET_BINDINGS: Record<
  string,
  { classId: string; property: string }
> = {
  Model: { classId: "MeshComponent", property: "assetGuid" },
  Mesh: { classId: "MeshComponent", property: "assetGuid" },
  Audio: { classId: "AudioComponent", property: "audioAssetGuid" },
  ParticleSystem: { classId: "ParticleComponent", property: "particleSystemGuid" },
  Sprite: { classId: "SpriteComponent", property: "assetGuid" },
  Tilemap: { classId: "TilemapComponent", property: "assetGuid" },
  AnimationGraph: { classId: "AnimationGraphComponent", property: "graphGuid" },
  BehaviourTree: { classId: "BehaviourTreeComponent", property: "treeGuid" },
};

const HIDDEN_COMPONENT_ANCESTORS = new Set([
  "NavMeshComponent",
  "NavMeshBlockerComponent",
  "BlockingVolumeComponent",
]);

const COMPONENT_GUID_PROPERTIES = [
  "assetGuid",
  "audioAssetGuid",
  "particleSystemGuid",
  "graphGuid",
  "treeGuid",
  "fontAssetGuid",
  "textureGuid",
  "materialGuid",
] as const;

export type ProjectAddComponentAsset = {
  path?: string;
  header: {
    guid: string;
    name: string;
    type: string;
    parentClass?: string | null;
  };
};

export function projectAddComponentItems(
  assets: readonly ProjectAddComponentAsset[],
): AddComponentItem[] {
  const parentOf = classParentLookup(assets);
  const items: AddComponentItem[] = [];
  for (const asset of assets) {
    const type = asset.header.type;
    const binding = PROJECT_ASSET_BINDINGS[type];
    if (binding) {
      items.push({
        id: `asset-${asset.header.guid}`,
        classId: binding.classId,
        label: asset.header.name,
        description: type,
        category: "Project",
        properties: { [binding.property]: asset.header.guid },
      });
      continue;
    }
    if (type !== "Class") continue;
    const classId = classIdFromClassAsset(asset);
    if (isLockedEngineClassId(classId)) continue;
    const ancestry = walkAncestry(classId, parentOf);
    if (!ancestry.includes("ActorComponent")) continue;
    if (ancestry.includes("Actor")) continue;
    if (ancestry.some((id) => HIDDEN_COMPONENT_ANCESTORS.has(id))) continue;
    items.push({
      id: `class-${classId}`,
      classId,
      label: asset.header.name,
      description: "Actor Component",
      category: "Project",
      properties: {},
    });
  }
  return items;
}

export function prefabComponentLabel(
  component: {
    classId: string;
    properties?: Record<string, unknown>;
  },
  assetLabel?: (guid: string) => string | undefined,
): string {
  const typeLabel =
    ADDABLE_COMPONENT_CLASSES.find((entry) => entry.id === component.classId)
      ?.label ??
    humanizePropertyLabel(component.classId.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  const guid = componentGuid(component.properties);
  const name = guid ? assetLabel?.(guid) : undefined;
  return name ? `${typeLabel} (${name})` : typeLabel;
}

function componentGuid(
  properties: Record<string, unknown> | undefined,
): string | null {
  if (!properties) return null;
  for (const key of COMPONENT_GUID_PROPERTIES) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function physicsWorldFromOpenDocuments(
  openDocuments: ReadonlyArray<{
    ref: { kind: string };
    content: unknown;
  }>,
): PhysicsWorldKind {
  const sceneDoc = openDocuments.find(
    (entry) =>
      (entry.ref.kind === "scene" || entry.ref.kind === "scene-layer") &&
      entry.content,
  );
  const settings = (sceneDoc?.content as SerializedScene | undefined)?.settings;
  if (sceneDoc?.ref.kind === "scene-layer") return "2d";
  return settings?.physicsWorld === "2d" ? "2d" : "3d";
}

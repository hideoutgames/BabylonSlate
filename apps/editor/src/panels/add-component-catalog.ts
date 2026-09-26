import { normalizeWaterBody, normalizeWaterBuoyancy, normalizeWaterRemoval, waterKindForClass } from "@babylonslate/core";
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
  parseAreaRectLightProperties,
  parseOutlineProperties,
  parseRagdollProperties,
  parseSpringArmProperties,
  createRichText2DComponent,
  createText2DComponent,
} from "@babylonslate/core";
import {
  parseColliderProperties,
  parseConstraintProperties,
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
  ancestry?: string[];
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
  engineComponent("AreaRectLightComponent", "Rectangular Area Light", "Unshadowed rectangular emitter; illuminates through walls", "Rendering"),
  engineComponent("OutlineComponent", "Outline", "Actor silhouette with independent color, width and visibility", "Rendering"),
  engineComponent(
    "HemisphericFillLightComponent",
    "Hemispheric Fill Light",
    "Sky and ground fill lighting",
    "Rendering",
  ),
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
    "SpringArmComponent",
    "Spring Arm",
    "Holds child components at the end of an arm with optional location and rotation lag",
    "Camera",
  ),
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
  engineComponent("GlobalWaterVolumeComponent", "Global Water Volume", "Horizon-wide water with camera-adaptive detail", "Water"),
  engineComponent("WaterOceanComponent", "Water Ocean", "Resizable rectangular water with broad waves", "Water"),
  engineComponent("WaterLakeComponent", "Water Lake", "Bounded water with gentle waves", "Water"),
  engineComponent("WaterRiverComponent", "Water River", "Path-shaped water with a flowing current", "Water"),
  engineComponent("WaterPuddleComponent", "Water Puddle", "Shallow water with small ripples", "Water"),
  engineComponent("WaterRemovalVolumeComponent", "Water Removal Volume", "Removes water inside a box, sphere, cylinder or capsule", "Water"),
  engineComponent("WaterBuoyancyComponent", "Water Buoyancy", "Float with waves and respond to physics impacts", "Water"),
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
    "2DPanelComponent",
    "2D Panel",
    "Scalable 9-slice plane from a Texture or Material",
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
  engineComponent(
    "PhysicsConstraintComponent",
    "Physics Constraint",
    "Connect two physics actors with a fixed, ball socket, hinge, or distance joint",
    "Physics",
  ),
  engineComponent(
    "RagdollComponent",
    "Ragdoll",
    "Simulate a Model skeleton from its current animation pose (3D)",
    "Physics",
  ),
];

export function defaultPropertiesFor(
  classId: string,
  physicsWorld: PhysicsWorldKind = "3d",
  viewportMode: ViewportMode = "3d",
): Record<string, unknown> {
  const waterKind = waterKindForClass(classId);
  if (waterKind) return { ...normalizeWaterBody({}, waterKind) };
  if (classId === "WaterBuoyancyComponent") return { ...normalizeWaterBuoyancy({}), mass: 1 };
  if (classId === "WaterRemovalVolumeComponent") return { ...normalizeWaterRemoval({}) };
  switch (classId) {
    case "MeshComponent":
      return {
        meshKind: "box",
        assetGuid: null,
        collisionMode: "simple",
        layer: 1,
        mask: 0xffffffff,
      };
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
    case "AreaRectLightComponent":
      return { ...parseAreaRectLightProperties({}) };
    case "OutlineComponent":
      return { ...parseOutlineProperties({}) };
    case "SpringArmComponent":
      return { ...parseSpringArmProperties({}) };
    case "HemisphericFillLightComponent":
      return {
        intensity: 0.9,
        color: [1, 1, 1],
        groundColor: [0, 0, 0],
        enabled: true,
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
    case "2DPanelComponent":
      return {
        source: "texture",
        textureGuid: null,
        materialGuid: null,
        marginLeft: 0,
        marginRight: 0,
        marginTop: 0,
        marginBottom: 0,
        hitTest: "ignore",
      };
    case "2DTextComponent":
      return { ...createText2DComponent("text").properties };
    case "2DRichTextComponent":
      return { ...createRichText2DComponent("rich").properties };
    case "RigidBodyComponent":
      return { ...parseRigidBodyProperties({}) };
    case "ColliderComponent":
      return { ...parseColliderProperties({}, physicsWorld) };
    case "PhysicsConstraintComponent":
      return { ...parseConstraintProperties({}, physicsWorld) };
    case "RagdollComponent":
      return { ...parseRagdollProperties({}) };
    default:
      return {};
  }
}

export function addableComponentsForHost(options: {
  overlay: boolean;
  physicsWorld?: PhysicsWorldKind;
}): AddComponentItem[] {
  return ADDABLE_COMPONENT_CLASSES.filter((entry) => {
    if ((options.overlay || options.physicsWorld === "2d") && entry.classId === "RagdollComponent") return false;
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
  Water: { classId: "WaterLakeComponent", property: "assetGuid" },
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
      ancestry,
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

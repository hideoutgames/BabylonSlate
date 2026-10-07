import { UI_CONTROL_2D_CLASS_IDS, OVERLAY_LAYOUT_CLASSES } from "@babylonslate/core";
import type { PhysicsWorldKind, SerializedComponent, SerializedScene, ViewportMode } from "@babylonslate/core";
import { defaultComponentAuthoringProperties } from "@babylonslate/runtime";
import { humanizePropertyLabel, walkAncestry } from "@babylonslate/editor-kit";
import { isLockedEngineClassId, isSceneLayerAllowedComponent, isSceneLayerExclusiveComponent } from "@babylonslate/object-model";
import {
  classIdFromClassAsset,
  classParentLookup,
} from "../lib/content-browser-helpers";
import { fittedColliderShape } from "../lib/fitted-collider";

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
  engineComponent("SaveGameComponent", "Save Game", "Save selected actor transforms and script variables at checkpoints", "General"),
  engineComponent(
    "MovementComponent",
    "Movement",
    "Actor movement, jumping, and air control driven by graph calls",
    "General",
  ),
  engineComponent(
    "SplineComponent",
    "Spline",
    "Editable 3D path with smooth curves and optional closed loops",
    "General",
  ),
  engineComponent(
    "MeshComponent",
    "Mesh",
    "Primitive or Model asset",
    "Rendering",
  ),
  engineComponent("SpriteComponent", "Sprite", "2D sprite quad", "Rendering"),
  engineComponent("DynamicRuntimeMeshComponent", "Dynamic Runtime Mesh", "Create and update mesh geometry from component functions during Play", "Rendering"),
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
  engineComponent("FogVolumeComponent", "Fog Volume", "Local box or sphere of volumetric fog with soft edges", "Rendering"),
  engineComponent("OutlineComponent", "Outline", "Actor silhouette with independent color, width and visibility", "Rendering"),
  engineComponent("DeformerComponent", "Deformer", "Runtime lattice deformation of a mesh or model after material offsets", "Rendering"),
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
  engineComponent("RenderTargetCaptureComponent", "Render Target Capture", "Captures a selected render pass into a Render Target", "Camera"),
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
  ...UI_CONTROL_2D_CLASS_IDS.map(classId => engineComponent(classId, humanizePropertyLabel(classId.replace(/Component$/, "")), "Interactive SceneLayer control with configurable materials and textures", "Overlay")),
  ...OVERLAY_LAYOUT_CLASSES.map(classId => engineComponent(classId, humanizePropertyLabel(classId.replace(/Component$/, "")), classId === "2DPaddingComponent" ? "Insets the parent content without drawing a surface" : "Nested SceneLayer layout", "Overlay")),
  engineComponent("2DJoystickComponent", "2D Joystick", "Touch joystick with configurable background and joystick materials", "Overlay"),
  engineComponent("2DPainterComponent", "2D Painter", "Draw shapes, paths, curves and masks with graph nodes", "Overlay"),
  engineComponent(
    "2DAnchorComponent",
    "2D Anchor",
    "Pins an overlay actor to a SceneLayer edge or center",
    "Overlay",
  ),
  engineComponent(
    "2DButtonComponent",
    "2D Button",
    "Pointer events and keyboard or gamepad focus navigation",
    "Overlay",
  ),
  engineComponent("2DFocusTargetComponent", "2D Focus Target", "Keyboard and gamepad focus for any overlay element", "Overlay"),
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
  engineComponent("CableComponent", "Cable", "Simulated cable with optional scene collision", "Physics"),
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
  siblings: readonly SerializedComponent[] = [],
): Record<string, unknown> {
  const defaults = defaultComponentAuthoringProperties(classId, physicsWorld, viewportMode);
  if (classId !== "ColliderComponent") return defaults;
  const shape = defaults.shape as { kind: Parameters<typeof fittedColliderShape>[0] };
  return { ...defaults, shape: fittedColliderShape(shape.kind, siblings) ?? defaults.shape };
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

/**
 * Pure classification of serialized actors for the editor scene: which components draw a visual, which actors need an
 * origin root and which helper billboard an actor shows. `scene-loader.ts` re-exports the public names.
 */
import {
  identitySerializedTransform, isOverlayLayoutClass, isSceneLayerAnchorActor, isUIControl2DClass, MIRROR_CLASS_ID,
  OVERLAY_LAYOUT_CLASSES, SPRING_ARM_COMPONENT_CLASS_ID, UI_CONTROL_2D_CLASS_IDS, waterKindForClass, type SerializedActor,
  type SerializedComponent, type SerializedTransform,
} from "@haptic/core";
import { authoredComponentActorTransform } from "./authored-transform-matrices";
import { lightBillboardIcon, type EditorBillboardIcon } from "./editor-billboard";
import { isAuthoredLightClassId } from "./scene-illumination";

export function stringProp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const VISUAL_COMPONENT_CLASS_IDS = new Set([
  "2DPainterComponent",
  ...OVERLAY_LAYOUT_CLASSES,
  "DynamicRuntimeMeshComponent",
  "CableComponent",
  MIRROR_CLASS_ID,
  "SplineComponent",
  "GlobalWaterVolumeComponent", "WaterOceanComponent", "WaterLakeComponent", "WaterRiverComponent", "WaterPuddleComponent",
  "LandscapeComponent",
  "FoliageComponent",
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "LightComponent",
  "HemisphericFillLightComponent",
  "CameraComponent",
  "RenderTargetCaptureComponent",
  SPRING_ARM_COMPONENT_CLASS_ID,
  "AudioComponent",
  "SkyboxComponent",
  "Text3DComponent",
  "2DTextComponent",
  "2DRichTextComponent",
  "2DJoystickComponent",
  ...UI_CONTROL_2D_CLASS_IDS,
  "2DTextureComponent",
  "2DMaterialComponent",
  "2DPanelComponent",
  "2DButtonComponent",
  "ParticleComponent",
  "ColliderComponent",
  "NavMeshComponent",
  "NavMeshBlockerComponent",
  "BlockingVolumeComponent",
  "WaterRemovalVolumeComponent",
  "FogVolumeComponent",
  "ReflectionProbeComponent",
]);

const SURFACE_COMPONENT_CLASS_IDS = new Set([
  "2DPainterComponent",
  "DynamicRuntimeMeshComponent",
  "CableComponent",
  MIRROR_CLASS_ID,
  "SplineComponent",
  "GlobalWaterVolumeComponent", "WaterOceanComponent", "WaterLakeComponent", "WaterRiverComponent", "WaterPuddleComponent",
  "LandscapeComponent",
  "FoliageComponent",
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "SkyboxComponent",
  "Text3DComponent",
  "2DTextComponent",
  "2DRichTextComponent",
  "2DJoystickComponent",
  ...UI_CONTROL_2D_CLASS_IDS,
  "2DTextureComponent",
  "2DMaterialComponent",
  "2DPanelComponent",
  "2DButtonComponent",
]);

function overlayActorHasSurfaceVisual(actor: SerializedActor): boolean {
  return actor.components.some(
    (component) =>
      isUIControl2DClass(component.classId) ||
      component.classId === "2DJoystickComponent" ||
      component.classId === "2DPainterComponent" ||
      component.classId === "2DTextureComponent" ||
      component.classId === "2DMaterialComponent" ||
      component.classId === "2DPanelComponent" ||
      component.classId === "2DTextComponent" ||
      component.classId === "2DRichTextComponent" ||
      component.classId === "SpriteComponent" ||
      component.classId === "MeshComponent",
  );
}

function isEditorOnlyText3D(component: SerializedComponent): boolean {
  return component.classId === "Text3DComponent" && component.properties.editorOnly === true;
}

/**
 * First-match actor lookups behind the per-actor visual rules. A streaming
 * actor, an editor label and a 2D button each ask about other actors, so a full
 * load builds one index instead of scanning the scene per question. Built
 * lazily: scenes without those actors never pay for it.
 */
export class SceneActorIndex {
  private readonly actors: readonly SerializedActor[];
  private byId: Map<string, SerializedActor> | undefined;
  private labelParents: Set<string> | undefined;

  constructor(actors: readonly SerializedActor[]) {
    this.actors = actors;
  }

  /** The first actor with this id, as `Array.find` answers. */
  find(id: string): SerializedActor | undefined {
    if (!this.byId) {
      this.byId = new Map();
      for (const actor of this.actors) if (!this.byId.has(actor.id)) this.byId.set(actor.id, actor);
    }
    return this.byId.get(id);
  }

  /** Whether an actor parented to `parentId` carries an editor-only Text3D label. */
  hasEditorLabelChild(parentId: string): boolean {
    if (!this.labelParents) {
      this.labelParents = new Set();
      for (const actor of this.actors) {
        if (actor.parentId != null && actor.components.some(isEditorOnlyText3D)) this.labelParents.add(actor.parentId);
      }
    }
    return this.labelParents.has(parentId);
  }
}

/** The scene's actors: a raw list is scanned per question, an index answers directly. */
export type SceneActorSource = readonly SerializedActor[] | SceneActorIndex;

function findSceneActor(actors: SceneActorSource | undefined, id: string): SerializedActor | undefined {
  if (!actors) return undefined;
  return actors instanceof SceneActorIndex ? actors.find(id) : actors.find((entry) => entry.id === id);
}

function hasEditorLabelChild(actors: SceneActorSource | undefined, parentId: string): boolean {
  if (!actors) return false;
  return actors instanceof SceneActorIndex
    ? actors.hasEditorLabelChild(parentId)
    : actors.some((entry) => entry.parentId === parentId && entry.components.some(isEditorOnlyText3D));
}

export function skipOverlayButtonVisual(
  actor: SerializedActor,
  allActors?: SceneActorSource,
): boolean {
  if (overlayActorHasSurfaceVisual(actor)) return true;
  const parent = actor.parentId ? findSceneActor(allActors, actor.parentId) : undefined;
  return parent ? overlayActorHasSurfaceVisual(parent) : false;
}

export function visualComponentsOf(
  actor: SerializedActor,
  allActors?: SceneActorSource,
): SerializedComponent[] {
  const streaming = actor.components.find((component) => component.classId === "SceneStreamingComponent");
  if (streaming) {
    const text = actor.components.find(isEditorOnlyText3D);
    const marker = { ...streaming, parentId: null, transform: authoredComponentActorTransform(actor, streaming) };
    // Prefab previews represent each component as an actor. Its authored label
    // already exists on a child actor, so it must not gain a synthetic sibling.
    const childLabel = !text && hasEditorLabelChild(allActors, actor.id);
    if (childLabel) return [marker];
    return [marker, {
      ...(text ?? { id: `${streaming.id}:label`, classId: "Text3DComponent",
        transform: { ...identitySerializedTransform(), position: [0, 0.8, 0] } }),
      parentId: streaming.id,
      properties: { size: 0.25, alignment: "center", ...text?.properties,
        text: stringProp(streaming.properties.sceneName) ?? "Unassigned Scene", editorOnly: true },
    }];
  }
  const parentStreaming = parentStreamingComponentOf(actor, allActors);
  return actor.components.filter((component) => {
    if (!VISUAL_COMPONENT_CLASS_IDS.has(component.classId)) return false;
    if (
      component.classId === "2DButtonComponent" &&
      skipOverlayButtonVisual(actor, allActors)
    ) {
      return false;
    }
    return true;
  }).map((component) => parentStreaming && component.classId === "Text3DComponent" && component.properties.editorOnly === true
    ? { ...component, properties: { ...component.properties, text: stringProp(parentStreaming.properties.sceneName) ?? "Unassigned Scene" } }
    : component);
}

export function parentStreamingComponentOf(
  actor: SerializedActor,
  allActors?: SceneActorSource,
): SerializedComponent | undefined {
  if (!actor.parentId || !actor.components.some(isEditorOnlyText3D)) return undefined;
  return findSceneActor(allActors, actor.parentId)?.components.find(
    (component) => component.classId === "SceneStreamingComponent",
  );
}

function isIdentitySerializedTransform(
  transform: SerializedTransform | undefined,
): boolean {
  const value = transform ?? identitySerializedTransform();
  return (
    value.position[0] === 0 &&
    value.position[1] === 0 &&
    value.position[2] === 0 &&
    value.rotation[0] === 0 &&
    value.rotation[1] === 0 &&
    value.rotation[2] === 0 &&
    value.rotation[3] === 1 &&
    value.scale[0] === 1 &&
    value.scale[1] === 1 &&
    value.scale[2] === 1
  );
}

export function isBillboardComponent(component: SerializedComponent): boolean {
  return (
    component.classId === "SceneStreamingComponent" ||
    isAuthoredLightClassId(component.classId) ||
    component.classId === "CameraComponent" ||
    component.classId === "RenderTargetCaptureComponent" ||
    component.classId === "AudioComponent" ||
    component.classId === "ParticleComponent" ||
    component.classId === "NavMeshComponent"
  );
}

/** Whether an actor owns an authored surface rather than only editor helpers. */
export function hasSurfaceVisual(actor: SerializedActor): boolean {
  return actor.components.some((component) =>
    SURFACE_COMPONENT_CLASS_IDS.has(component.classId),
  );
}

export function helperBillboardIconOf(
  actor: SerializedActor,
): EditorBillboardIcon | null {
  if (actor.components.some(c => isOverlayLayoutClass(c.classId))) return null;
  if (isSceneLayerAnchorActor(actor)) return null;
  if (actor.components.some((component) => component.classId === "SceneStreamingComponent")) return "default";
  if (hasSurfaceVisual(actor)) return null;
  const fill = actor.components.find(
    (component) => component.classId === "HemisphericFillLightComponent",
  );
  if (fill) return "directional_light";
  if (actor.components.some((component) => component.classId === "AreaRectLightComponent")) return "directional_light";
  const light = actor.components.find(
    (component) => component.classId === "LightComponent",
  );
  if (light) return lightBillboardIcon(light.properties.lightKind);
  if (actor.components.some((component) => component.classId === "CameraComponent" || component.classId === "RenderTargetCaptureComponent")) {
    return "camera";
  }
  if (actor.components.some((component) => component.classId === "AudioComponent")) {
    return "audio";
  }
  if (
    actor.components.some((component) => component.classId === "ParticleComponent")
  ) {
    return "particle";
  }
  if (actor.components.some((component) => component.classId === "NavMeshComponent")) {
    return "navmesh";
  }
  return "default";
}

export function needsOriginRoot(
  actor: SerializedActor,
  allActors?: SceneActorSource,
): boolean {
  const visuals = visualComponentsOf(actor, allActors);
  return (
    actor.components.some(c => isOverlayLayoutClass(c.classId)) ||
    helperBillboardIconOf(actor) !== null ||
    visuals.length > 1 ||
    visuals.some((component) => component.classId === "CableComponent" || component.classId === MIRROR_CLASS_ID) ||
    visuals.some((component) => component.classId === "DynamicRuntimeMeshComponent") ||
    visuals.some((component) => waterKindForClass(component.classId) !== null || component.classId === "WaterRemovalVolumeComponent" || component.classId === "SplineComponent") ||
    visuals.some((component) => component.classId === "FogVolumeComponent" || component.classId === "ReflectionProbeComponent") ||
    visuals.some((component) => component.classId === "LandscapeComponent" || component.classId === "FoliageComponent") ||
    visuals.some((component) => !isIdentitySerializedTransform(component.transform)) ||
    visuals.some(isBillboardComponent) ||
    visuals.some((component) => component.classId === "ColliderComponent") ||
    visuals.some((component) => component.classId === SPRING_ARM_COMPONENT_CLASS_ID) ||
    visuals.some(
      (component) =>
        component.classId === "NavMeshBlockerComponent" ||
        component.classId === "BlockingVolumeComponent",
    )
  );
}

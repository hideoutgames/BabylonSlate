import type { CommandMessage } from "@babylonslate/bridge";
import {
  areaRectLightBindings,
  deformerBindings,
  DEFORMER_PROPERTY_KEYS,
  fogVolumeBindings,
  isInteractiveUIControl2DClass,
  isOverlayLayoutClass,
  isUIControl2DClass,
  normalizeWaterBody,
  normalizeWaterRemoval,
  outlineBindings,
  overlayPanelDestFromScale,
  parseFoliageProperties,
  parseJoystick2DProperties,
  parseLandscapeProperties,
  parseOverlayPanelProperties,
  parseOverlayVisualStyle,
  parseSceneLayerHitTest,
  parseSkyboxFaces,
  parseSkyboxSize,
  parseSpringArmProperties,
  parseText2DProperties,
  parseText3DProperties,
  SPRING_ARM_COMPONENT_CLASS_ID,
  supportsOverlayVisualStyle,
  waterKindForClass,
  type SerializedScene,
  type Transform,
} from "@babylonslate/core";
import { MaterialObject, type Actor, type ActorComponent, type World } from "@babylonslate/object-model";
import { actorParentGuid } from "./actor-world-transform";
import type { CableWorldSync } from "./cable-sync";
import type { DynamicRuntimeMeshSync } from "./dynamic-runtime-mesh";
import type { Painter2DRuntime } from "./painter2d-runtime";
import { RenderCommandState } from "./render-command-state";
import { captureComponent, captureLocalTransform, captureProperties } from "./render-targets";
import type { RuntimeMaterialParameters } from "./runtime-material-parameters";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { Text2DAppearRuntime } from "./text2d-appear-runtime";
import type { UIControls2DRuntime } from "./ui-controls2d-runtime";

interface RenderCommandEmitterHost {
  world(): World;
  /** The actor belongs to a streamed Scene (its Skybox stays with the main Scene). */
  isStreamActor(actor: Actor): boolean;
  /** The main Scene, for its default camera. */
  playScene(): SerializedScene | undefined;
  /** The render slot this actor's own commands target. */
  slot(actor: Actor): number | undefined;
  cables(): Pick<CableWorldSync, "assign">;
  dynamicMeshes(): Pick<DynamicRuntimeMeshSync, "assign">;
  uiControls(): Pick<UIControls2DRuntime, "payload">;
  painters(): Pick<Painter2DRuntime, "payload">;
  textAppear(): Pick<Text2DAppearRuntime, "progress">;
  materialParameters(): Pick<RuntimeMaterialParameters, "captureOverrides">;
  emit(command: CommandMessage): void;
}

/**
 * Builds and sends an actor's component render commands: `assignMesh`,
 * materials, outlines, deformers, fog volumes, render target capture, area
 * lights and component transforms. The driver decides when; this owns what
 * each slot was last sent, so a later call sends only a change or the
 * clearing command.
 */
export class RenderCommandEmitter implements RuntimeSubsystem {
  private readonly state = new RenderCommandState();
  /** Global `setActorDeformers` revision; never reset for the driver's lifetime. */
  private deformerRevision = 0;
  private readonly componentsWithMaterialAssignment = new WeakSet<ActorComponent>();
  private readonly host: RenderCommandEmitterHost;

  constructor(host: RenderCommandEmitterHost) { this.host = host; }

  releaseSlot(slotId: number, owner: Actor | undefined): void {
    this.state.releaseSlot(slotId, owner);
  }

  /** Send this actor's deformers after the current tick (`flushDeformers`). */
  queueDeformers(actor: Actor): void {
    this.state.dirtyDeformerActors.add(actor);
  }

  /** The component is one of the owner's Play renderables, so it has a native view. */
  rendersComponent(owner: Actor, component: ActorComponent): boolean {
    const skipButtonMesh = overlayButtonHasSiblingVisual(owner) || overlayButtonHasParentVisual(owner, this.host.world());
    return owner.components.some((entry) => entry === component && isPlayRenderable(entry, skipButtonMesh));
  }

  emitActorOutlines(actor: Actor, slotId: number): void {
    const components = actor.components.filter((component) => !component.destroyed && component.classId === "OutlineComponent");
    if (components.length || this.state.outlineSlots.has(slotId)) {
      const outlines = outlineBindings(actor.guid, components.map((component) => ({
        id: component.guid, classId: component.classId,
        properties: Object.fromEntries(["enabled", "color", "width", "throughMeshes"].map((key) =>
          [key, key === "color" && component.getVariable(key) != null ? rgbTuple(component.getVariable(key)) : component.getVariable(key)])),
      })));
      this.host.emit({ type: "setActorOutlines", slotId, actorId: actor.guid, outlines });
      if (outlines.length) this.state.outlineSlots.add(slotId); else this.state.outlineSlots.delete(slotId);
    }
  }

  emitActorDeformers(actor: Actor, slotId: number): void {
    this.state.dirtyDeformerActors.delete(actor);
    const components = actor.components.filter((component) => !component.destroyed &&
      (component.classId === "DeformerComponent" || component.classId === "MeshComponent"));
    if (!components.some((component) => component.classId === "DeformerComponent") && !this.state.deformerSnapshots.has(slotId)) return;
    const deformers = actor.sceneLayerId ? [] : deformerBindings(actor.guid, components.map((component) => ({
      id: component.guid, classId: component.classId, ...(component.sourceId ? { sourceId: component.sourceId } : {}),
      properties: component.classId === "DeformerComponent"
        ? Object.fromEntries(DEFORMER_PROPERTY_KEYS.map((key) => [key, component.getVariable(key)])) : {},
    })));
    const snapshot = JSON.stringify(deformers);
    if (snapshot === this.state.deformerSnapshots.get(slotId) || (!deformers.length && !this.state.deformerSnapshots.has(slotId))) return;
    this.state.deformerSnapshots.set(slotId, snapshot);
    this.host.emit({ type: "setActorDeformers", slotId, actorId: actor.guid, revision: ++this.deformerRevision, deformers });
  }

  flushDeformers(): void {
    for (const actor of this.state.dirtyDeformerActors) {
      const slotId = this.host.slot(actor);
      if (!actor.destroyed && slotId !== undefined) this.emitActorDeformers(actor, slotId);
    }
    this.state.dirtyDeformerActors.clear();
  }

  emitActorFogVolumes(actor: Actor, slotId: number): void {
    const hasVolume = !actor.sceneLayerId && actor.components.some((component) =>
      !component.destroyed && component.classId === "FogVolumeComponent");
    if (!hasVolume && !this.state.fogVolumeSlots.has(slotId)) return;
    const volumes = hasVolume ? fogVolumeBindings(actor.components.filter((component) => !component.destroyed).map((component) => {
      const { position, rotation, scale } = component.transform;
      const size = component.getVariable("size");
      return {
        id: component.guid, classId: component.classId, parentId: component.parentId,
        properties: component.classId === "FogVolumeComponent" ? {
          enabled: component.getVariable("enabled"), shape: component.getVariable("shape"),
          size: size == null ? undefined : rgbTuple(size), density: component.getVariable("density"),
          edgeFalloff: component.getVariable("edgeFalloff"),
        } : {},
        transform: { position: [position.x, position.y, position.z] as [number, number, number],
          rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as [number, number, number, number],
          scale: [scale.x, scale.y, scale.z] as [number, number, number] },
      };
    })) : [];
    this.host.emit({ type: "setFogVolumes", slotId, actorId: actor.guid, volumes });
    if (volumes.length) this.state.fogVolumeSlots.add(slotId); else this.state.fogVolumeSlots.delete(slotId);
  }

  private cameraAssignPayload(
    actor: Actor,
    camera: ActorComponent,
  ): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["camera"]> {
    const projection = camera.getVariable("projectionMode");
    const settings = this.host.playScene()?.settings;
    return {
      projectionMode:
        projection === "orthographic" ? "orthographic" : "perspective",
      fieldOfView: Number(camera.getVariable("fieldOfView") ?? 60),
      orthographicSize: Number(camera.getVariable("orthographicSize") ?? 5),
      nearClip: Number(camera.getVariable("nearClip") ?? 0.1),
      farClip: Number(camera.getVariable("farClip") ?? 1000),
      isDefault:
        settings?.mainCameraActorId === actor.guid &&
        settings.mainCameraComponentId === camera.guid,
    };
  }

  emitRenderTargetCapture(actor: Actor, slotId: number): void {
    const component = captureComponent(actor);
    if (!component && !this.state.captureSlots.has(slotId)) return;
    this.host.emit({
      type: "configureRenderTargetCapture", actorGuid: actor.guid, slotId,
      settings: component ? captureProperties(component) : null,
      ...(component ? { transform: captureLocalTransform(component) } : {}),
    });
    if (component) this.state.captureSlots.add(slotId); else this.state.captureSlots.delete(slotId);
  }

  emitComponentTransforms(actor: Actor, slotId: number): void {
    const renderables = playRenderablesOf(actor.components,
      overlayButtonHasSiblingVisual(actor) || overlayButtonHasParentVisual(actor, this.host.world()));
    const ids = new Set(renderables.map(component => component.guid));
    const components = new Map(actor.components.map(component => [component.guid, component]));
    this.host.emit({ type: "setComponentTransforms", slotId, parts: renderables.map(component => ({
      componentId: component.guid, parentId: nearestVisualParentId(component, components, ids),
      transform: { position: { ...component.transform.position }, rotation: { ...component.transform.rotation }, scale: { ...component.transform.scale } },
      parentTransforms: dynamicMeshParentTransforms(component, components, ids),
    })) });
  }

  emitMeshAssignment(actor: Actor, slotId: number): void {
    if (this.host.world().classRegistry.isA(actor.classId, "SceneStreamingActor")) return;
    this.emitRenderTargetCapture(actor, slotId);
    this.emitActorOutlines(actor, slotId);
    this.emitActorDeformers(actor, slotId);
    this.emitActorFogVolumes(actor, slotId);
    const hasAreaLight = actor.components.some((component) => component.classId === "AreaRectLightComponent" && !component.destroyed);
    if (hasAreaLight || this.state.areaLightSlots.has(slotId)) {
    const lights = hasAreaLight ? areaRectLightBindings(actor.components.filter((component) => !component.destroyed).map((component) => {
      const { position, rotation, scale } = component.transform;
      return {
        id: component.guid, classId: component.classId, parentId: component.parentId,
        properties: component.classId === "AreaRectLightComponent" ? Object.fromEntries(["enabled", "width", "height", "color", "intensity", "textureGuid"].map((key) => [key, key === "color" ? rgbTuple(component.getVariable(key)) : component.getVariable(key)])) : {},
        transform: { position: [position.x, position.y, position.z] as [number, number, number], rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as [number, number, number, number], scale: [scale.x, scale.y, scale.z] as [number, number, number] },
      };
    })) : [];
    // A separate component command also handles actors with meshes, multiple
    // emitters and asynchronous model loading. It uses the same view owner.
    this.host.emit({ type: "setAreaLights", slotId, lights });
    if (lights.length) this.state.areaLightSlots.add(slotId); else this.state.areaLightSlots.delete(slotId);
    }
    const skipButtonMesh =
      overlayButtonHasSiblingVisual(actor) ||
      overlayButtonHasParentVisual(actor, this.host.world());
    const renderables = playRenderablesOf(this.host.isStreamActor(actor)
      ? actor.components.filter((component) => component.classId !== "SkyboxComponent")
      : actor.components, skipButtonMesh);
    if (renderables.length > 0) {
      const primary = renderables[0]!;
      const meshKind = playMeshKindOf(primary);
      const panelComp = renderables.find(
        (component) => component.classId === "2DPanelComponent",
      );
      const overlayPanel = panelComp
        ? {
            ...parseOverlayPanelProperties(overlayPanelVariables(panelComp)),
            ...overlayPanelDestFromScale(
              actor.transform.scale.x,
              actor.transform.scale.y,
            ),
          }
        : null;
      const componentAssetGuid =
        primary.assetGuid ?? primary.getVariable("assetGuid");
      const assetGuid =
        overlayPanel
          ? overlayPanel.source === "material"
            ? overlayPanel.materialGuid
            : overlayPanel.textureGuid
          : primary.classId === "MeshComponent"
            ? componentAssetGuid
            : (componentAssetGuid ??
              primary.getVariable("textureGuid") ??
              primary.getVariable("materialGuid"));
      const renderableIds = new Set(renderables.map((component) => component.guid));
      const componentsByGuid = new Map(
        actor.components.map((component) => [component.guid, component]),
      );
      const parts = playPartsNeeded(renderables) ||
        renderables.some((component) => component.classId === SPRING_ARM_COMPONENT_CLASS_ID)
        ? renderables.map((component) => ({
            ...playMeshPartOf(
              component,
              nearestVisualParentId(
                component,
                componentsByGuid,
                renderableIds,
              ),
            ),
            ...(supportsOverlayVisualStyle(component.classId) ? { overlayStyle: parseOverlayVisualStyle(Object.fromEntries(component.variables)) } : {}),
            ...(component.classId === "CableComponent" ? { cable: this.host.cables().assign(component) } : {}),
            ...(component.classId === "2DJoystickComponent" ? { joystick: parseJoystick2DProperties(Object.fromEntries(component.variables)) } : {}),
            ...(isUIControl2DClass(component.classId) ? { uiControl: { classId: component.classId, properties: this.host.uiControls().payload(component) } } : {}),
            ...(component.classId === "2DPainterComponent" ? { painter: this.host.painters().payload(component) } : {}),
            ...(component.classId === "2DRichTextComponent" ? { text2d: text2dAssignPayload(component, this.host.textAppear().progress(component)) } : {}),
            ...(component.classId === "DynamicRuntimeMeshComponent" ? { dynamicMesh: this.host.dynamicMeshes().assign(component) } : {}),
            ...(component.classId === "LightComponent" || component.classId === "HemisphericFillLightComponent" ? { light: lightAssignPayload(component) } : {}),
            ...(component.classId === "CameraComponent" ? { camera: this.cameraAssignPayload(actor, component) } : {}),
            parentTransforms: dynamicMeshParentTransforms(component, componentsByGuid, renderableIds),
          }))
        : undefined;
      const skyboxComp = renderables.find(
        (component) => component.classId === "SkyboxComponent",
      );
      const text3dComp = renderables.find(
        (component) => component.classId === "Text3DComponent",
      );
      const text2dComp = renderables.find(
        (component) =>
          component.classId === "2DTextComponent" ||
          component.classId === "2DRichTextComponent",
      );
      const cameras = renderables.filter(component => component.classId === "CameraComponent");
      const camera = cameras.find(component => this.cameraAssignPayload(actor, component).isDefault) ?? cameras[0];
      const light = renderables.find(component => component.classId === "LightComponent" || component.classId === "HemisphericFillLightComponent");
      this.host.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
        meshKind,
        actorGuid: actor.guid,
        ...(!parts
          ? { primaryComponentId: primary.guid }
          : {}),
        ...(supportsOverlayVisualStyle(primary.classId) ? { overlayStyle: parseOverlayVisualStyle(Object.fromEntries(primary.variables)) } : {}),
        ...(meshKind === "sprite" || meshKind === "tilemap"
          ? playSortingOf(primary)
          : {}),
        ...(actor.sceneLayerId
          ? {
              sceneLayerId: actor.sceneLayerId,
              ...overlayMeshInteraction(actor, this.host.world()),
            }
          : {}),
        ...(skyboxComp
          ? {
              skybox: {
                size: parseSkyboxSize(skyboxComp.getVariable("size")),
                faces: parseSkyboxFaces(skyboxComp.getVariable("faces")),
              },
            }
          : {}),
        ...(text3dComp
          ? {
              text3d: text3dAssignPayload(text3dComp),
            }
          : {}),
        ...(text2dComp ? { text2d: text2dAssignPayload(text2dComp,
          text2dComp.classId === "2DRichTextComponent" ? this.host.textAppear().progress(text2dComp) : 1) } : {}),
        ...(camera ? { camera: this.cameraAssignPayload(actor, camera) } : {}),
        ...(light ? { light: lightAssignPayload(light) } : {}),
        ...(overlayPanel ? { overlayPanel } : {}),
        ...(parts ? { parts } : {}),
      });
      this.emitMaterialAssignments(renderables, slotId, Boolean(parts));
      return;
    }
    const capture = captureComponent(actor);
    if (capture) {
      this.host.emit({ type: "assignMesh", slotId, actorGuid: actor.guid, meshAssetGuid: null, meshKind: "renderTargetCapture", parts: [playMeshPartOf(capture)] });
      return;
    }
    const audio = actor.components.find(
      (component) =>
        component.classId === "AudioComponent" && !component.destroyed,
    );
    if (audio) {
      this.host.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: "audio",
        parts: [playMeshPartOf(audio)],
      });
      return;
    }
    const particle = actor.components.find(
      (component) =>
        component.classId === "ParticleComponent" && !component.destroyed,
    );
    if (particle) {
      this.host.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: "particle",
        parts: [playMeshPartOf(particle)],
      });
      return;
    }
    const rigid = actor.components.find(
      (component) =>
        component.classId === "RigidBodyComponent" && !component.destroyed,
    );
    if (rigid) {
      this.host.emit({
        type: "assignMesh",
        slotId,
        meshAssetGuid: null,
        meshKind: "rigidbody",
        parts: [playMeshPartOf(rigid)],
      });
    } else if (this.state.fogVolumeSlots.has(slotId)) {
      this.host.emit({ type: "assignMesh", slotId, meshAssetGuid: null, meshKind: null });
    }
  }

  emitMaterialAssignments(
    renderables: readonly ActorComponent[],
    slotId: number,
    multipart: boolean,
  ): void {
    for (const component of renderables) {
      if (component.classId === "2DTextComponent" || component.classId === "2DRichTextComponent") continue;
      const value = component.getVariable("materialGuid");
      const guid = typeof value === "string" && value.trim() ? value : null;
      if (guid) this.componentsWithMaterialAssignment.add(component);
      else if (
        !this.componentsWithMaterialAssignment.delete(component) &&
        component.getVariable("materialSource") !== "override"
      ) {
        // Untouched model components retain their authored material slots.
        continue;
      }
      this.host.emit({
        type: "assignMaterial",
        slotId,
        materialAssetGuid: guid,
        ...(multipart || component.classId === "MeshComponent"
          ? { componentId: component.guid }
          : {}),
      });
      const material = component.getVariable("materialObject");
      if (component.materialInstance?.materialGuid === guid && material instanceof MaterialObject) {
        for (const [parameterName, parameter] of Object.entries(this.host.materialParameters().captureOverrides(material) ?? {})) {
          this.host.emit({ type: "setMaterialParameter", slotId, componentId: component.guid,
            materialAssetGuid: material.materialAssetGuid, parameterName, parameter });
        }
      }
    }
  }
}

const OVERLAY_BUTTON_VISUAL_CLASS_IDS = new Set([
  "2DPainterComponent",
  "2DJoystickComponent",
  "2DTextureComponent",
  "2DMaterialComponent",
  "2DPanelComponent",
  "2DTextComponent",
  "2DRichTextComponent",
  "SpriteComponent",
  "MeshComponent",
]);

function overlayButtonHasSiblingVisual(actor: Actor): boolean {
  return overlayActorHasVisual(actor);
}

function overlayActorHasVisual(actor: Actor): boolean {
  return actor.components.some(
    (component) =>
      !component.destroyed && (OVERLAY_BUTTON_VISUAL_CLASS_IDS.has(component.classId) || isUIControl2DClass(component.classId)),
  );
}

function overlayButtonHasParentVisual(actor: Actor, world: World): boolean {
  const parentId = actorParentGuid(actor);
  if (!parentId) return false;
  const parent = world.findActor(parentId);
  return parent ? overlayActorHasVisual(parent) : false;
}

export function liveOverlayButtons(actor: Actor): ActorComponent[] {
  return actor.components.filter(
    (component) =>
      component.classId === "2DButtonComponent" && !component.destroyed,
  );
}

function overlayMeshInteraction(
  actor: Actor,
  world: World,
): {
  hitTest: "ignore" | "block" | "passThrough";
  hasButton: boolean;
  buttonComponentId?: string;
} {
  const buttons = liveOverlayButtons(actor);
  // Own buttons take precedence. Share one child scan across all metadata.
  if (buttons.length === 0) {
    for (const child of world.getActors()) {
      if (actorParentGuid(child) === actor.guid) {
        buttons.push(...liveOverlayButtons(child));
      }
    }
  }
  return {
    hitTest: overlayHitTestOf(actor, buttons[0]),
    hasButton: buttons.length > 0,
    ...(buttons.length === 1 ? { buttonComponentId: buttons[0]!.guid } : {}),
  };
}

function overlayPanelVariables(component: ActorComponent): Record<string, unknown> {
  return {
    source: component.getVariable("source"),
    textureGuid: component.getVariable("textureGuid"),
    materialGuid: component.getVariable("materialGuid"),
    marginLeft: component.getVariable("marginLeft"),
    marginRight: component.getVariable("marginRight"),
    marginTop: component.getVariable("marginTop"),
    marginBottom: component.getVariable("marginBottom"),
    hitTest: component.getVariable("hitTest"),
  };
}

function isPlayRenderable(
  component: ActorComponent,
  skipButtonMesh: boolean,
): boolean {
  if (component.destroyed || component.getVariable("editorOnly") === true) return false;
  if (isUIControl2DClass(component.classId)) return !!component.owner?.sceneLayerId;
  if (isOverlayLayoutClass(component.classId)) return true;
  if (component.classId === "LightComponent" || component.classId === "HemisphericFillLightComponent" || component.classId === "CameraComponent" || component.classId === SPRING_ARM_COMPONENT_CLASS_ID) return true;
  if (waterKindForClass(component.classId) || component.classId === "WaterRemovalVolumeComponent") return true;
  if (component.classId === "2DButtonComponent") return !skipButtonMesh;
  if (
    component.classId === "LandscapeComponent" ||
    component.classId === "FoliageComponent" ||
    component.classId === "CableComponent" ||
    component.classId === "DynamicRuntimeMeshComponent" ||
    component.classId === "MeshComponent" ||
    component.classId === "SpriteComponent" ||
    component.classId === "TilemapComponent" ||
    component.classId === "SkyboxComponent" ||
    component.classId === "Text3DComponent" ||
    component.classId === "2DJoystickComponent" ||
    component.classId === "2DTextureComponent" ||
    component.classId === "2DMaterialComponent" ||
    component.classId === "2DPanelComponent" ||
    component.classId === "2DPainterComponent" ||
    component.classId === "2DTextComponent" ||
    component.classId === "2DRichTextComponent"
  ) {
    return true;
  }
  return (
    component.classId === "ColliderComponent" &&
    component.getVariable("renderInGame") === true
  );
}

/** Components that contribute visuals, illumination or camera poses to Play. */
function playRenderablesOf(
  components: readonly ActorComponent[],
  skipButtonMesh: boolean,
): ActorComponent[] {
  return components.filter(component => isPlayRenderable(component, skipButtonMesh));
}

function overlayHitTestOf(
  actor: Actor,
  button: ActorComponent | undefined,
): "ignore" | "block" | "passThrough" {
  if (button) {
    return parseSceneLayerHitTest(button.getVariable("hitTest"), "block");
  }
  if (actor.components.some(component => component.classId === "2DJoystickComponent" && !component.destroyed && component.getVariable("enabled") !== false)) return "block";
  if (actor.components.some(component => isInteractiveUIControl2DClass(component.classId) && !component.destroyed && component.getVariable("enabled") !== false)) return "block";
  const visual = actor.components.find(
    (component) =>
      (component.classId === "2DTextureComponent" ||
        component.classId === "2DMaterialComponent" ||
        component.classId === "2DPanelComponent" ||
        component.classId === "2DPainterComponent" ||
        component.classId === "2DTextComponent" ||
        component.classId === "2DRichTextComponent") &&
      !component.destroyed,
  );
  if (visual) {
    return parseSceneLayerHitTest(visual.getVariable("hitTest"), "ignore");
  }
  return "ignore";
}

function playSortingOf(component: ActorComponent): {
  sortingLayer: string;
  orderInLayer: number;
} {
  const layer = component.getVariable("sortingLayer");
  const order = component.getVariable("orderInLayer");
  return {
    sortingLayer:
      typeof layer === "string" && layer.trim() !== "" ? layer : "Default",
    orderInLayer:
      typeof order === "number" && Number.isFinite(order) ? Math.round(order) : 0,
  };
}

function playMeshKindOf(component: ActorComponent): string | null {
  if (isUIControl2DClass(component.classId)) return "2dcontrol";
  if (isOverlayLayoutClass(component.classId)) return "2dlayout";
  if (component.classId === "CableComponent") return "cable";
  if (component.classId === "DynamicRuntimeMeshComponent") return "dynamicRuntimeMesh";
  if (waterKindForClass(component.classId)) return "water";
  if (component.classId === "WaterRemovalVolumeComponent") return "waterRemoval";
  if (component.classId === "LandscapeComponent") return "landscape";
  if (component.classId === "FoliageComponent") return "foliage";
  if (component.classId === "SpriteComponent") return "sprite";
  if (component.classId === "TilemapComponent") return "tilemap";
  if (component.classId === "SkyboxComponent") return "skybox";
  if (component.classId === "Text3DComponent") return "text3d";
  if (component.classId === "2DTextComponent") return "2dtext";
  if (component.classId === "2DRichTextComponent") return "2drichtext";
  if (component.classId === "2DJoystickComponent") return "2djoystick";
  if (component.classId === "2DTextureComponent") return "2dtexture";
  if (component.classId === "2DMaterialComponent") return "2dmaterial";
  if (component.classId === "2DPanelComponent") return "2dpanel";
  if (component.classId === "2DPainterComponent") return "2dpainter";
  if (component.classId === "2DButtonComponent") return "2dbutton";
  if (component.classId === "ColliderComponent") {
    const shape = component.getVariable("shape");
    return `collider:${JSON.stringify(shape ?? {})}`;
  }
  if (component.classId === "HemisphericFillLightComponent") {
    return "light:hemispheric";
  }
  if (component.classId === "LightComponent") {
    const kind = component.getVariable("lightKind");
    return `light:${typeof kind === "string" ? kind : "point"}`;
  }
  if (component.classId === "CameraComponent") return "camera";
  if (component.classId === "RenderTargetCaptureComponent") return "renderTargetCapture";
  if (component.classId === SPRING_ARM_COMPONENT_CLASS_ID) return "springarm";
  if (component.classId === "AudioComponent") return "audio";
  if (component.classId === "ParticleComponent") return "particle";
  if (component.classId === "RigidBodyComponent") return "rigidbody";
  const meshKind = component.getVariable("meshKind");
  return typeof meshKind === "string" ? meshKind : null;
}

function isIdentityComponentTransform(component: ActorComponent): boolean {
  const { position, rotation, scale } = component.transform;
  return (
    position.x === 0 &&
    position.y === 0 &&
    position.z === 0 &&
    rotation.x === 0 &&
    rotation.y === 0 &&
    rotation.z === 0 &&
    rotation.w === 1 &&
    scale.x === 1 &&
    scale.y === 1 &&
    scale.z === 1
  );
}

function playPartsNeeded(components: readonly ActorComponent[]): boolean {
  return (
    components.some((component) => isUIControl2DClass(component.classId)) ||
    components.some((component) => isOverlayLayoutClass(component.classId) || component.classId === "LightComponent" || component.classId === "HemisphericFillLightComponent" || component.classId === "CameraComponent") ||
    components.some((component) => component.classId === "2DJoystickComponent") ||
    components.some((component) => component.classId === "2DPainterComponent") ||
    components.some((component) => component.classId === "CableComponent") ||
    components.some((component) => component.classId === "DynamicRuntimeMeshComponent") ||
    components.some((component) => waterKindForClass(component.classId) !== null || component.classId === "WaterRemovalVolumeComponent") ||
    components.length > 1 ||
    components.some((component) => component.classId === "LandscapeComponent" || component.classId === "FoliageComponent") ||
    components.some((component) => !isIdentityComponentTransform(component))
  );
}

function text3dAssignPayload(
  component: ActorComponent,
): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["text3d"]> {
  return parseText3DProperties({
    text: component.getVariable("text"),
    size: component.getVariable("size"),
    depth: component.getVariable("depth"),
    color: component.getVariable("color"),
    fontAssetGuid: component.getVariable("fontAssetGuid"),
    alignment: component.getVariable("alignment"),
  });
}

function text2dAssignPayload(
  component: ActorComponent,
  appearProgress = 1,
): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["text2d"]> {
  const parsed = parseText2DProperties(
    {
      text: component.getVariable("text"),
      materialGuid: component.getVariable("materialGuid"),
      materialUv: component.getVariable("materialUv"),
      fontAssetGuid:
        component.getVariable("fontAssetGuid") ?? component.assetGuid,
      size: component.getVariable("size"),
      color: component.getVariable("color"),
      renderer: component.getVariable("renderer"),
      outline: component.getVariable("outline"),
      outlineColor: component.getVariable("outlineColor"),
      alignment: component.getVariable("alignment"),
      verticalAlignment: component.getVariable("verticalAlignment"),
      bold: component.getVariable("bold"),
      italic: component.getVariable("italic"),
      underline: component.getVariable("underline"),
      wrapWidth: component.getVariable("wrapWidth"),
      wrapHeight: component.getVariable("wrapHeight"),
      appearModes: component.getVariable("appearModes"),
      appearTransition: component.getVariable("appearTransition"),
      appearInterval: component.getVariable("appearInterval"),
      appearDuration: component.getVariable("appearDuration"),
      appearStart: component.getVariable("appearStart"),
    },
    { rich: component.classId === "2DRichTextComponent" },
  );
  return {
    text: parsed.text,
    materialGuid: parsed.materialGuid,
    materialUv: parsed.materialUv,
    fontAssetGuid: parsed.fontAssetGuid,
    size: parsed.size,
    color: parsed.color,
    renderer: parsed.renderer,
    outline: parsed.outline,
    outlineColor: parsed.outlineColor,
    alignment: parsed.alignment,
    verticalAlignment: parsed.verticalAlignment,
    bold: parsed.bold,
    italic: parsed.italic,
    underline: parsed.underline,
    wrapWidth: parsed.wrapWidth,
    wrapHeight: parsed.wrapHeight,
    appearModes: parsed.appearModes,
    appearTransition: parsed.appearTransition,
    appearInterval: parsed.appearInterval,
    appearDuration: parsed.appearDuration,
    appearStart: parsed.appearStart,
    appearProgress,
  };
}

function lightAssignPayload(component: ActorComponent): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["light"]> {
  const fill = component.classId === "HemisphericFillLightComponent";
  const ground = component.getVariable("groundColor");
  return {
    color: rgbTuple(component.getVariable("color")),
    intensity: Number(component.getVariable("intensity") ?? (fill ? 0.9 : 1)),
    enabled: component.getVariable("enabled") !== false,
    ...(fill ? { groundColor: ground == null ? [0, 0, 0] as [number, number, number] : rgbTuple(ground) } : {
      range: Number(component.getVariable("range") ?? 10),
      innerAngle: Number(component.getVariable("innerAngle") ?? 30),
      outerAngle: Number(component.getVariable("outerAngle") ?? 45),
      castShadows: component.getVariable("castShadows") === true,
      shadowPriority: Number(component.getVariable("shadowPriority") ?? 0),
    }),
  };
}

function playMeshPartOf(
  component: ActorComponent,
  parentId = component.parentId,
): NonNullable<Extract<CommandMessage, { type: "assignMesh" }>["parts"]>[number] {
  const assetGuid = component.assetGuid ?? component.getVariable("assetGuid");
  const { position, rotation, scale } = component.transform;
  return {
    componentId: component.guid,
    ...(component.classId === "LandscapeComponent" ? { landscape: parseLandscapeProperties(Object.fromEntries(
      ["width", "depth", "subdivisions", "heights", "weights", "materialGuid", "collisionsEnabled"].map((key) => [key, component.getVariable(key)]),
    )) } : {}),
    ...(component.classId === "FoliageComponent" ? { foliage: parseFoliageProperties({ groupId: component.getVariable("groupId"), batches: component.getVariable("batches") }) } : {}),
    castShadows: component.getVariable("castShadows") !== false,
    receiveShadows: component.getVariable("receiveShadows") !== false,
    meshKind: playMeshKindOf(component),
    meshAssetGuid: typeof assetGuid === "string" ? assetGuid : null,
    parentId,
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    scale: [scale.x, scale.y, scale.z],
    ...(waterKindForClass(component.classId) ? { water: normalizeWaterBody(Object.fromEntries(component.variables), waterKindForClass(component.classId)!) } : {}),
    ...(component.classId === "WaterRemovalVolumeComponent" ? { waterRemoval: normalizeWaterRemoval(Object.fromEntries(component.variables)) } : {}),
    ...(component.classId === "Text3DComponent"
      ? {
          text3d: text3dAssignPayload(component),
        }
      : {}),
    ...(component.classId === "2DTextComponent" ||
    component.classId === "2DRichTextComponent"
      ? { text2d: text2dAssignPayload(component) }
      : {}),
    ...(component.classId === "SpriteComponent" ||
    component.classId === "TilemapComponent"
      ? playSortingOf(component)
      : {}),
    ...(component.classId === SPRING_ARM_COMPONENT_CLASS_ID
      ? { springArm: springArmAssignPayload(component) }
      : {}),
  };
}

function springArmAssignPayload(
  component: ActorComponent,
): ReturnType<typeof parseSpringArmProperties> {
  return parseSpringArmProperties({
    armLength: component.getVariable("armLength"),
    enableLocationLag: component.getVariable("enableLocationLag"),
    locationLagSpeed: component.getVariable("locationLagSpeed"),
    maxLocationLagDistance: component.getVariable("maxLocationLagDistance"),
    enableRotationLag: component.getVariable("enableRotationLag"),
    rotationLagSpeed: component.getVariable("rotationLagSpeed"),
    drawDebugLag: component.getVariable("drawDebugLag"),
  });
}

function dynamicMeshParentTransforms(component: ActorComponent, components: ReadonlyMap<string, ActorComponent>, renderableIds: ReadonlySet<string>): Transform[] {
  const transforms: Transform[] = [];
  const visited = new Set<string>([component.guid]);
  let parentId = component.parentId;
  while (parentId && !visited.has(parentId) && !renderableIds.has(parentId)) {
    visited.add(parentId);
    const parent = components.get(parentId);
    if (!parent || parent.destroyed) break;
    transforms.push({ position: { ...parent.transform.position }, rotation: { ...parent.transform.rotation }, scale: { ...parent.transform.scale } });
    parentId = parent.parentId;
  }
  return transforms;
}

function nearestVisualParentId(
  component: ActorComponent,
  componentsByGuid: ReadonlyMap<string, ActorComponent>,
  renderableIds: ReadonlySet<string>,
): string | null {
  const visited = new Set<string>();
  let parentId = component.parentId;
  while (parentId && !visited.has(parentId)) {
    if (renderableIds.has(parentId)) return parentId;
    visited.add(parentId);
    parentId = componentsByGuid.get(parentId)?.parentId ?? null;
  }
  return null;
}

function rgbTuple(value: unknown): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    return [
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
    ];
  }
  if (value && typeof value === "object") {
    const row = value as { x?: unknown; y?: unknown; z?: unknown };
    if (typeof row.x === "number") {
      return [
        row.x,
        typeof row.y === "number" ? row.y : 0,
        typeof row.z === "number" ? row.z : 0,
      ];
    }
  }
  return [1, 1, 1];
}

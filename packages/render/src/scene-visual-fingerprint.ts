/**
 * Visual fingerprints: `EditorSceneSync` rebuilds an actor's meshes when its fingerprint changes, so a component's kind
 * must change whenever `createComponentMesh` in `scene-component-mesh.ts` would build a different mesh.
 * `scene-loader.ts` re-exports the public names.
 */
import {
  isOverlayLayoutClass, isUIControl2DClass, MIRROR_CLASS_ID, overlayPanelDestFromScale, parseCableProperties,
  parseFogVolumeProperties, parseMirrorProperties, parseOverlayLayoutProperties, parseOverlayPanelProperties,
  parseReflectionProbeProperties, parseSkyboxFaces, parseSkyboxSize, parseSpringArmProperties, parseText2DProperties,
  parseText3DProperties, SKYBOX_FACE_KEYS, SPRING_ARM_COMPONENT_CLASS_ID, waterKindForClass, type SerializedActor,
  type SerializedComponent,
} from "@haptic/core";
import { meshCollisionFingerprint } from "@haptic/assets";
import { editorBillboardKind, lightBillboardIcon } from "./editor-billboard";
import { EDITOR_CAMERA_MODEL_KIND } from "./editor-camera-model";
import { foliagePropertiesFingerprint, foliageSourceFingerprint } from "./foliage-mesh";
import type { MeshAssetContext } from "./mesh-assets";
import { overlayPanelVisualKind } from "./overlay-panel-mesh";
import { overlayTextureVisualKind } from "./overlay-texture-quad";
import {
  helperBillboardIconOf, needsOriginRoot, skipOverlayButtonVisual, stringProp, visualComponentsOf, type SceneActorSource,
} from "./scene-visual-classify";

function componentVisualKind(
  component: SerializedComponent,
  assets?: MeshAssetContext,
  actor?: SerializedActor,
): string {
  if (isOverlayLayoutClass(component.classId)) {
    const props = parseOverlayLayoutProperties(component.properties, component.classId);
    return `layout:${component.classId}:${component.properties.layoutResolvedWidth ?? props.width}:${component.properties.layoutResolvedHeight ?? props.height}`;
  }
  if (component.classId === "SceneStreamingComponent") return editorBillboardKind("default");
  const asset = stringProp(component.properties.assetGuid) ?? "";
  if (component.classId === "CableComponent") {
    // Only topology, Enabled (which the frozen active-mesh queue must see) and
    // Material rebuild the tube; other edits apply live in syncEditorCablePreviews.
    // Construction assigns the Material, and editor material binding restores a
    // mesh's construction material when the guid is cleared, so a Material
    // change needs a fresh mesh. The rebuilt mesh keeps its editor simulation.
    const cable = parseCableProperties(component.properties);
    return `cable:${cable.enabled}:${cable.numSegments}:${cable.numSides}:${cable.tileMaterial}:${JSON.stringify(cable.materialGuid)}`;
  }
  if (component.classId === "DynamicRuntimeMeshComponent") return "dynamicRuntimeMesh";
  // Every property but the Material rebuilds the surface; editor material binding applies the override.
  if (component.classId === MIRROR_CLASS_ID) return `mirror:${JSON.stringify({ ...parseMirrorProperties(component.properties), materialGuid: null })}`;
  if (component.classId === "SplineComponent") return `spline:${JSON.stringify(component.properties)}`;
  if (waterKindForClass(component.classId)) return `water:${component.classId}:${JSON.stringify(component.properties)}`;
  if (component.classId === "WaterRemovalVolumeComponent") return `waterRemoval:${JSON.stringify(component.properties)}`;
  if (component.classId === "FogVolumeComponent") {
    const volume = parseFogVolumeProperties(component.properties);
    return `fogVolume:${volume.shape}:${volume.size.join(",")}`;
  }
  if (component.classId === "ReflectionProbeComponent") return `reflectionProbe:${parseReflectionProbeProperties(component.properties).size.join(",")}`;
  if (component.classId === "LandscapeComponent") return `landscape:${component.properties.subdivisions}`;
  if (component.classId === "FoliageComponent") return `foliage:${foliagePropertiesFingerprint(component.properties)}:${foliageSourceFingerprint(component.properties, assets)}`;
  if (component.classId === "MeshComponent") {
    const kind =
      typeof component.properties.meshKind === "string"
        ? component.properties.meshKind
        : "box";
    const collision = meshCollisionFingerprint(
      component.properties,
      asset ? assets?.modelPayloads?.get(asset) : undefined,
    );
    return `mesh:${kind}:${asset}:${collision}`;
  }
  if (component.classId === "SpriteComponent") return `sprite:${asset}`;
  if (component.classId === "TilemapComponent") return `tilemap:${asset}`;
  if (component.classId === "HemisphericFillLightComponent") {
    return editorBillboardKind("directional_light");
  }
  if (component.classId === "LightComponent") {
    return editorBillboardKind(lightBillboardIcon(component.properties.lightKind));
  }
  if (component.classId === "CameraComponent" || component.classId === "RenderTargetCaptureComponent") return EDITOR_CAMERA_MODEL_KIND;
  if (component.classId === SPRING_ARM_COMPONENT_CLASS_ID) {
    return `springarm:${parseSpringArmProperties(component.properties).armLength}`;
  }
  if (component.classId === "AudioComponent") return editorBillboardKind("audio");
  if (component.classId === "SkyboxComponent") {
    const size = parseSkyboxSize(component.properties.size);
    const faces = parseSkyboxFaces(component.properties.faces);
    return `skybox:${size}:${SKYBOX_FACE_KEYS.map((key) => faces[key] ?? "").join(",")}`;
  }
  if (component.classId === "Text3DComponent") {
    const parsed = parseText3DProperties(component.properties);
    return `text3d:${parsed.text}:${parsed.size}:${parsed.color.join(",")}:${parsed.fontAssetGuid ?? ""}:${parsed.alignment}`;
  }
  if (
    component.classId === "2DTextComponent" ||
    component.classId === "2DRichTextComponent"
  ) {
    const parsed = parseText2DProperties(component.properties, {
      rich: component.classId === "2DRichTextComponent",
    });
    return `2dtext:${component.classId}:${parsed.text}:${parsed.size}:${parsed.renderer}:${parsed.fontAssetGuid ?? ""}:${parsed.color.join(",")}:${parsed.alignment}:${parsed.verticalAlignment}:${parsed.bold}:${parsed.italic}:${parsed.underline}:${parsed.outline}:${parsed.wrapWidth}:${parsed.wrapHeight}:${parsed.hitTest}:${parsed.materialGuid ?? ""}:${parsed.materialUv}`;
  }
  if (component.classId === "2DTextureComponent") {
    return overlayTextureVisualKind(
      stringProp(component.properties.textureGuid),
      component.properties.hitTest,
      assets?.textureBytes,
      assets?.pixelsPerUnit,
      assets?.texturePixelSizes,
    );
  }
  if (component.classId === "2DMaterialComponent") {
    return `2dmaterial:${stringProp(component.properties.materialGuid) ?? ""}:${String(component.properties.hitTest ?? "ignore")}`;
  }
  if (isUIControl2DClass(component.classId)) return `2dcontrol:${component.classId}:${JSON.stringify(component.properties)}`;
  if (component.classId === "2DJoystickComponent" || component.classId === "2DPainterComponent") {
    const structural = Object.fromEntries(Object.entries(component.properties).filter(([key]) => key !== "opacity" && key !== "tint"));
    return `${component.classId === "2DJoystickComponent" ? "2djoystick" : "2dpainter"}:${JSON.stringify(structural)}`;
  }
  if (component.classId === "2DPanelComponent") {
    const dest = overlayPanelDestFromScale(
      actor?.transform.scale[0] ?? 1,
      actor?.transform.scale[1] ?? 1,
    );
    return overlayPanelVisualKind(
      {
        ...parseOverlayPanelProperties(component.properties),
        destWidth: dest.destWidth,
        destHeight: dest.destHeight,
      },
      assets,
    );
  }
  if (component.classId === "2DButtonComponent") {
    return `2dbutton:${String(component.properties.hitTest ?? "block")}`;
  }
  if (component.classId === "ParticleComponent") {
    return editorBillboardKind("particle");
  }
  if (component.classId === "NavMeshComponent") {
    return editorBillboardKind("navmesh");
  }
  if (component.classId === "NavMeshBlockerComponent") {
    const kind =
      component.properties.kind === "cylinder" ? "cylinder" : "box";
    return `volume:navblocker:${kind}`;
  }
  if (component.classId === "BlockingVolumeComponent") {
    return "volume:blocking";
  }
  if (component.classId === "ColliderComponent") {
    return `collider:${JSON.stringify(component.properties.shape ?? {})}`;
  }
  return component.classId;
}

/** Fingerprint so EditorSceneSync rebuilds when visual parts change. */
export function actorVisualFingerprint(
  actor: SerializedActor,
  assets?: MeshAssetContext,
  allActors?: SceneActorSource,
): string {
  const visuals = visualComponentsOf(actor, allActors);
  const mode = needsOriginRoot(actor, allActors) ? "origin" : "single";
  if (visuals.length === 0) {
    return `${mode}:${editorMeshKindOf(actor, assets, allActors) ?? ""}`;
  }
  return `${mode}:${visuals
    .map((component) => `${component.id}:${componentVisualKind(component, assets, actor)}`)
    .join(";")}`;
}

/** Resolve the editor mesh kind, including billboard helpers for location-only components. */
export function editorMeshKindOf(
  actor: SerializedActor,
  assets?: MeshAssetContext,
  allActors?: SceneActorSource,
): string | null {
  const cable = actor.components.find((component) => component.classId === "CableComponent");
  if (cable) return componentVisualKind(cable);
  const meshComponent = actor.components.find(
    (component) => component.classId === "MeshComponent",
  );
  const spriteComponent = actor.components.find(
    (component) => component.classId === "SpriteComponent",
  );
  const tilemapComponent = actor.components.find(
    (component) => component.classId === "TilemapComponent",
  );
  const asset =
    stringProp(meshComponent?.properties.assetGuid) ||
    stringProp(spriteComponent?.properties.assetGuid) ||
    stringProp(tilemapComponent?.properties.assetGuid) ||
    "";
  if (typeof meshComponent?.properties.meshKind === "string") {
    return `${meshComponent.properties.meshKind}:${asset}`;
  }
  if (spriteComponent) return `sprite:${asset}`;
  if (tilemapComponent) return `tilemap:${asset}`;
  if (
    actor.components.some(
      (component) => component.classId === "HemisphericFillLightComponent",
    )
  ) {
    return editorBillboardKind("directional_light");
  }
  if (actor.components.some((component) => component.classId === "LightComponent")) {
    const light = actor.components.find(
      (component) => component.classId === "LightComponent",
    );
    return editorBillboardKind(lightBillboardIcon(light?.properties.lightKind));
  }
  if (actor.components.some((component) => component.classId === "AreaRectLightComponent")) return editorBillboardKind("directional_light");
  if (actor.components.some((component) => component.classId === "CameraComponent" || component.classId === "RenderTargetCaptureComponent")) {
    return EDITOR_CAMERA_MODEL_KIND;
  }
  if (actor.components.some((component) => component.classId === "AudioComponent")) {
    return editorBillboardKind("audio");
  }
  const skyboxComponent = actor.components.find(
    (component) => component.classId === "SkyboxComponent",
  );
  if (skyboxComponent) return componentVisualKind(skyboxComponent);
  const text3dComponent = actor.components.find(
    (component) => component.classId === "Text3DComponent",
  );
  if (text3dComponent) return componentVisualKind(text3dComponent);
  const text2dComponent = actor.components.find(
    (component) =>
      component.classId === "2DTextComponent" ||
      component.classId === "2DRichTextComponent",
  );
  if (text2dComponent) return componentVisualKind(text2dComponent);
  const texture2dComponent = actor.components.find(
    (component) => component.classId === "2DTextureComponent",
  );
  if (texture2dComponent) return componentVisualKind(texture2dComponent, assets);
  const material2dComponent = actor.components.find(
    (component) => component.classId === "2DMaterialComponent",
  );
  if (material2dComponent) return componentVisualKind(material2dComponent, assets);
  const panel2dComponent = actor.components.find(
    (component) => component.classId === "2DPanelComponent",
  );
  if (panel2dComponent) return componentVisualKind(panel2dComponent, assets, actor);
  const control2dComponent = actor.components.find(component => isUIControl2DClass(component.classId));
  if (control2dComponent) return componentVisualKind(control2dComponent, assets, actor);
  const joystick2dComponent = actor.components.find(component => component.classId === "2DJoystickComponent");
  if (joystick2dComponent) return componentVisualKind(joystick2dComponent, assets, actor);
  const painter2dComponent = actor.components.find((component) => component.classId === "2DPainterComponent");
  if (painter2dComponent) return componentVisualKind(painter2dComponent, assets, actor);
  const button2dComponent = actor.components.find(
    (component) => component.classId === "2DButtonComponent",
  );
  if (button2dComponent && !skipOverlayButtonVisual(actor, allActors)) {
    return componentVisualKind(button2dComponent, assets);
  }
  if (
    actor.components.some((component) => component.classId === "ParticleComponent")
  ) {
    return editorBillboardKind("particle");
  }
  if (actor.components.some((component) => component.classId === "NavMeshComponent")) {
    return editorBillboardKind("navmesh");
  }
  const helper = helperBillboardIconOf(actor);
  return helper ? editorBillboardKind(helper) : null;
}

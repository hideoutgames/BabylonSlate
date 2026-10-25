/**
 * The editor's Babylon mesh for one visual component, and the primitive meshes editor and Play share. A property read
 * here at build time must also change the component's kind in `scene-visual-fingerprint.ts`, or edits to it never
 * rebuild the mesh. `scene-loader.ts` re-exports the public names.
 */
import { Color3, Mesh, MeshBuilder, StandardMaterial, Vector3, type Scene } from "@babylonjs/core";
import {
  isOverlayLayoutClass, isUIControl2DClass, MIRROR_CLASS_ID, normalizeWaterBody, overlayPanelDestFromScale,
  parseCableProperties, parseMirrorProperties, parseOverlayLayoutProperties, parseOverlayPanelProperties,
  parseSpringArmProperties, SPRING_ARM_COMPONENT_CLASS_ID, supportsOverlayVisualStyle, waterKindForClass,
  type SerializedActor, type SerializedComponent,
} from "@haptic/core";
import { parseColliderProperties } from "@haptic/physics";
import { createCableMesh } from "./cable-mesh";
import { createColliderVisualMesh } from "./collider-visual";
import { createDynamicRuntimeMesh } from "./dynamic-runtime-mesh";
import { applyEditorBillboardFromActor, applyEditorBillboardPass, createEditorBillboard, lightBillboardIcon } from "./editor-billboard";
import { createEditorCameraModel } from "./editor-camera-model";
import { BLOCKING_VOLUME_COLOR, createEditorVolumeMesh, NAV_BLOCKER_VOLUME_COLOR, type EditorVolumeKind } from "./editor-volume";
import { createFogVolumeGuide, createReflectionProbeGuide } from "./fog-volume-guide";
import { createFoliageMesh } from "./foliage-mesh";
import { GIZMO_AXIS_COLORS } from "./gizmo-host";
import { createModelActorRoot } from "./glb-anim";
import { shareHelperProgram } from "./helper-program";
import { createJoystick2DMesh } from "./joystick2d-mesh";
import { createLandscapeMesh } from "./landscape-mesh";
import { applyAlbedoTexture, applyTilemapAlbedoTextures, type MeshAssetContext } from "./mesh-assets";
import { attachMeshCollisionDashes } from "./mesh-collision-dashes";
import { createMirrorSurfaceMesh } from "./mirrors";
import { createOverlayPanelMesh } from "./overlay-panel-mesh";
import { createOverlayTextureQuad, createOverlayUnlitMaterial } from "./overlay-texture-quad";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import { createPainter2DMesh } from "./painter2d-mesh";
import { parentStreamingComponentOf, stringProp, type SceneActorSource } from "./scene-visual-classify";
import { sceneShadowController } from "./shadow-controller";
import { createSkyboxMeshForFaces } from "./skybox";
import { applyComponentSorting } from "./sorting";
import { createSplineMesh } from "./spline-mesh";
import { createEditorSpringArmMesh } from "./spring-arm";
import { createSpriteQuad } from "./sprite-quad";
import { createText2DMesh } from "./text2d-mesh";
import { createText3DMesh } from "./text3d-mesh";
import { createTilemapMeshes, worldTileSize } from "./tilemap-mesh";
import { createUIControl2DMesh } from "./ui-controls2d-mesh";
import { VisualBundle } from "./visual-bundle";
import { createWaterMesh } from "./water-mesh";
import { createWaterRemovalMesh } from "./water-removal-mesh";

/** Build a primitive mesh for editor or Play from a MeshComponent kind. */
export function createPrimitiveMesh(
  scene: Scene,
  name: string,
  meshKind: string | null | undefined,
): Mesh {
  switch (meshKind) {
    case "sphere":
      return MeshBuilder.CreateSphere(name, { diameter: 1.5 }, scene);
    case "cylinder":
      return MeshBuilder.CreateCylinder(name, { height: 1.5, diameter: 1 }, scene);
    case "plane":
    case "quad":
      return MeshBuilder.CreatePlane(name, { size: 1.5 }, scene);
    case "ground":
      return MeshBuilder.CreateGround(name, { width: 10, height: 10 }, scene);
    case "box":
      return MeshBuilder.CreateBox(name, { size: 1.5 }, scene);
    case "sprite":
      return createSpriteQuad(scene, name, {
        name: "idle",
        u: 0,
        v: 0,
        uSize: 1,
        vSize: 1,
        durationMs: 100,
        pivot: { x: 0.5, y: 0.5 },
        width: 100,
        height: 100,
      });
    case "tilemap":
      return MeshBuilder.CreatePlane(name, { size: 1 }, scene);
    case "pivot":
      return createPivotMarkerMesh(scene, name);
    default:
      return MeshBuilder.CreateBox(name, { size: 1.5 }, scene);
  }
}

function createPivotMarkerMesh(scene: Scene, name: string): Mesh {
  const root = MeshBuilder.CreateSphere(name, { diameter: 0.14 }, scene);
  root.isPickable = true;
  const bundle = new VisualBundle();
  root.onDisposeObservable.addOnce(() => bundle.dispose());
  const material = bundle.ownMaterial(shareHelperProgram(new StandardMaterial(`${name}-pivot`, scene)));
  material.disableLighting = true;
  material.emissiveColor = new Color3(0.92, 0.93, 0.96);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  root.material = material;
  const axes: Array<{
    suffix: string;
    end: Vector3;
    color: Color3;
  }> = [
    { suffix: "axis-x", end: new Vector3(0.55, 0, 0), color: GIZMO_AXIS_COLORS.x },
    { suffix: "axis-y", end: new Vector3(0, 0.55, 0), color: GIZMO_AXIS_COLORS.y },
    { suffix: "axis-z", end: new Vector3(0, 0, 0.55), color: GIZMO_AXIS_COLORS.z },
  ];
  for (const axis of axes) {
    const line = MeshBuilder.CreateLines(
      `${name}:${axis.suffix}`,
      { points: [Vector3.Zero(), axis.end] },
      scene,
    );
    line.color = axis.color;
    line.parent = root;
    line.isPickable = false;
  }
  return root;
}

function colliderWorldKindFromShape(value: unknown): "3d" | "2d" | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (
    kind === "box2d" ||
    kind === "circle" ||
    kind === "capsule2d" ||
    kind === "polygon" ||
    kind === "chain"
  ) {
    return "2d";
  }
  if (
    kind === "box" ||
    kind === "sphere" ||
    kind === "capsule" ||
    kind === "cylinder" ||
    kind === "convex" ||
    kind === "mesh"
  ) {
    return "3d";
  }
  return null;
}

export function createSpriteComponentMesh(
  scene: Scene,
  name: string,
  component: SerializedComponent,
  assets?: MeshAssetContext,
): Mesh {
  const spriteGuid = stringProp(component.properties.assetGuid);
  const payload = spriteGuid ? assets?.spritePayloads?.get(spriteGuid) : undefined;
  const frame = payload?.frames[0];
  const mesh = frame
    ? createSpriteQuad(scene, name, frame, payload?.pixelsPerUnit ?? assets?.pixelsPerUnit)
    : createPrimitiveMesh(scene, name, "sprite");
  applyAlbedoTexture(mesh, scene, payload?.textureGuid, assets);
  applyAuthoredComponentSorting(mesh, component, assets?.sortingLayers);
  return mesh;
}

export function createTilemapComponentMesh(
  scene: Scene,
  name: string,
  component: SerializedComponent,
  assets?: MeshAssetContext,
): Mesh {
  const mapGuid = stringProp(component.properties.assetGuid);
  const tilemap = mapGuid ? assets?.tilemaps?.get(mapGuid) : undefined;
  const tilesets = assets?.tilesets ?? new Map();
  if (tilemap && tilesets.size > 0) {
    const size = worldTileSize(tilemap, assets?.pixelsPerUnit ?? 100);
    const mesh = createTilemapMeshes(
      scene,
      name,
      tilemap,
      tilesets,
      size.width,
      size.height,
    );
    applyTilemapAlbedoTextures(mesh, scene, assets);
    applyAuthoredComponentSorting(mesh, component, assets?.sortingLayers);
    return mesh;
  }
  return createPrimitiveMesh(scene, name, "tilemap");
}

/** Build a Babylon mesh for one visual component. */
export function createMeshForComponent(
  scene: Scene,
  name: string,
  actor: SerializedActor,
  component: SerializedComponent,
  assets?: MeshAssetContext,
  allActors?: SceneActorSource,
): Mesh {
  const mesh = createComponentMesh(scene, name, actor, component, assets, allActors);
  if (supportsOverlayVisualStyle(component.classId)) applyOverlayVisualStyle(mesh, component.properties);
  return mesh;
}

function createComponentMesh(
  scene: Scene,
  name: string,
  actor: SerializedActor,
  component: SerializedComponent,
  assets?: MeshAssetContext,
  allActors?: SceneActorSource,
): Mesh {
  if (isOverlayLayoutClass(component.classId)) {
    const props = parseOverlayLayoutProperties(component.properties, component.classId);
    const mesh = MeshBuilder.CreatePlane(name, { width: Number(component.properties.layoutResolvedWidth ?? props.width) || 0.001, height: Number(component.properties.layoutResolvedHeight ?? props.height) || 0.001 }, scene);
    mesh.visibility = 0;
    return mesh;
  }
  if (component.classId === "CableComponent") {
    const properties = parseCableProperties(component.properties);
    const mesh = createCableMesh(scene, name, properties);
    if (properties.materialGuid) mesh.material = assets?.resolveMaterial?.(properties.materialGuid, { scene }) ?? null;
    sceneShadowController(scene).setParticipation(mesh, component.properties);
    return mesh;
  }
  if (component.classId === "DynamicRuntimeMeshComponent") return createDynamicRuntimeMesh(scene, name);
  if (component.classId === MIRROR_CLASS_ID) return createMirrorSurfaceMesh(scene, name, parseMirrorProperties(component.properties));
  if (component.classId === "SplineComponent") return createSplineMesh(scene, name, component.properties);
  if (component.classId === "SceneStreamingComponent") return createEditorBillboard(scene, name, "default");
  const waterKind = waterKindForClass(component.classId);
  if (waterKind) {
    const body = normalizeWaterBody(component.properties, waterKind);
    const definition = body.assetGuid ? assets?.waters?.get(body.assetGuid) : undefined;
    return createWaterMesh(scene, name, body, definition, definition?.materialGuid ? assets?.resolveMaterial?.(definition.materialGuid, { scene }) : null);
  }
  if (component.classId === "WaterRemovalVolumeComponent") return createWaterRemovalMesh(scene, name, component.properties, { editor: true });
  if (component.classId === "FogVolumeComponent") return createFogVolumeGuide(scene, name, component.properties);
  if (component.classId === "ReflectionProbeComponent") return createReflectionProbeGuide(scene, name, component.properties);
  if (component.classId === "LandscapeComponent") return createLandscapeMesh(scene, name, component.properties, assets);
  if (component.classId === "FoliageComponent") return createFoliageMesh(scene, name, component.properties, assets);
  if (component.classId === "SpriteComponent") {
    return createSpriteComponentMesh(scene, name, component, assets);
  }
  if (component.classId === "TilemapComponent") {
    return createTilemapComponentMesh(scene, name, component, assets);
  }
  if (component.classId === "HemisphericFillLightComponent") {
    const mesh = createEditorBillboard(scene, name, "directional_light");
    applyEditorBillboardFromActor(mesh, actor);
    return mesh;
  }
  if (component.classId === "LightComponent") {
    const mesh = createEditorBillboard(
      scene,
      name,
      lightBillboardIcon(component.properties.lightKind),
    );
    applyEditorBillboardFromActor(mesh, actor);
    return mesh;
  }
  if (component.classId === "CameraComponent" || component.classId === "RenderTargetCaptureComponent") {
    return createEditorCameraModel(scene, name);
  }
  if (component.classId === SPRING_ARM_COMPONENT_CLASS_ID) {
    return createEditorSpringArmMesh(
      scene,
      name,
      parseSpringArmProperties(component.properties).armLength,
    );
  }
  if (component.classId === "AudioComponent") {
    return createEditorBillboard(scene, name, "audio");
  }
  if (component.classId === "SkyboxComponent") {
    return createSkyboxMeshForFaces(
      scene,
      name,
      component.properties.faces,
      component.properties.size,
      assets,
    );
  }
  if (component.classId === "Text3DComponent") {
    const mesh = createText3DMesh(scene, name, component.properties, assets);
    if (component.properties.editorOnly === true && (actor.components.some((entry) => entry.classId === "SceneStreamingComponent") || parentStreamingComponentOf(actor, allActors))) {
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      applyEditorBillboardPass(mesh);
    }
    return mesh;
  }
  if (
    component.classId === "2DTextComponent" ||
    component.classId === "2DRichTextComponent"
  ) {
    return createText2DMesh(scene, name, { ...component.properties, appearProgress: 1 }, assets, {
      rich: component.classId === "2DRichTextComponent",
      bitmapLimits: { retainedBytes: assets?.retainedTextBitmapBytes },
    });
  }
  if (component.classId === "2DTextureComponent") {
    return createOverlayTextureQuad(
      scene,
      name,
      stringProp(component.properties.textureGuid),
      assets,
    );
  }
  if (component.classId === "2DMaterialComponent") {
    const mesh = MeshBuilder.CreatePlane(name, { width: 1, height: 1 }, scene);
    const bundle = new VisualBundle();
    mesh.onDisposeObservable.addOnce(() => bundle.dispose());
    mesh.material = createOverlayUnlitMaterial(scene, name, bundle);
    const guid = stringProp(component.properties.materialGuid);
    if (guid && assets?.resolveMaterial) {
      const compiled = assets.resolveMaterial(guid, { scene, unlit: true });
      if (compiled) mesh.material = compiled;
    }
    return mesh;
  }
  if (component.classId === "2DPanelComponent") {
    const dest = overlayPanelDestFromScale(
      actor.transform.scale[0],
      actor.transform.scale[1],
    );
    return createOverlayPanelMesh(
      scene,
      name,
      {
        ...parseOverlayPanelProperties(component.properties),
        destWidth: dest.destWidth,
        destHeight: dest.destHeight,
      },
      assets,
    );
  }
  if (component.classId === "2DButtonComponent") {
    const mesh = MeshBuilder.CreatePlane(name, { width: 1, height: 1 }, scene);
    const bundle = new VisualBundle();
    mesh.onDisposeObservable.addOnce(() => bundle.dispose());
    mesh.material = createOverlayUnlitMaterial(scene, name, bundle);
    return mesh;
  }
  if (isUIControl2DClass(component.classId)) return createUIControl2DMesh(scene, name, component, assets, component.id);
  if (component.classId === "2DJoystickComponent") return createJoystick2DMesh(scene, name, component.properties, assets);
  if (component.classId === "2DPainterComponent") return createPainter2DMesh(scene, name, component.properties);
  if (component.classId === "ParticleComponent") {
    return createEditorBillboard(scene, name, "particle");
  }
  if (component.classId === "NavMeshComponent") {
    return createEditorBillboard(scene, name, "navmesh");
  }
  if (component.classId === "NavMeshBlockerComponent") {
    const kind: EditorVolumeKind =
      component.properties.kind === "cylinder" ? "cylinder" : "box";
    return createEditorVolumeMesh(scene, name, kind, NAV_BLOCKER_VOLUME_COLOR);
  }
  if (component.classId === "BlockingVolumeComponent") {
    return createEditorVolumeMesh(scene, name, "box", BLOCKING_VOLUME_COLOR);
  }
  if (component.classId === "ColliderComponent") {
    const world =
      colliderWorldKindFromShape(component.properties.shape) ?? "3d";
    return createColliderVisualMesh(
      scene,
      name,
      // Draw draft or legacy sizes rather than failing the whole scene load;
      // Details still shows the collider so it can be corrected.
      parseColliderProperties(component.properties, world, { validation: "authoring" }).shape,
    );
  }
  const assetGuid = stringProp(component.properties.assetGuid);
  const visual = assetGuid
    ? createModelActorRoot(scene, name)
    : createPrimitiveMesh(
        scene,
        name,
        typeof component.properties.meshKind === "string"
          ? component.properties.meshKind
          : null,
      );
  attachMeshCollisionDashes(visual, component, assets);
  return visual;
}

export function applyAuthoredComponentSorting(mesh: Mesh, component: SerializedComponent, layers?: readonly string[]): void {
  const { sortingLayer, orderInLayer } = component.properties;
  applyComponentSorting(mesh, layers ?? ["Background", "Default", "Foreground", "UI"],
    typeof sortingLayer === "string" ? sortingLayer : "Default",
    typeof orderInLayer === "number" ? orderInLayer : 0);
}

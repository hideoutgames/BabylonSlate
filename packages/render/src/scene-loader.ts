import { Color3, Mesh, MeshBuilder, Quaternion, Scene, Vector3, StandardMaterial } from "@babylonjs/core";
import type { SerializedActor, SerializedComponent, SerializedScene, SerializedTransform } from "@babylonslate/core";
import {
  identitySerializedTransform,
  parseSkyboxFaces,
  parseSkyboxSize,
  parseText3DProperties,
  parseWidgetComponentProperties,
  SKYBOX_FACE_KEYS,
} from "@babylonslate/core";
import { applyAlbedoTexture, applyTilemapAlbedoTextures, type MeshAssetContext } from "./mesh-assets";
import {
  beginSlotModelAnimLoad,
  createModelActorRoot,
  hideModelPlaceholder,
  isEditorModelPlaceholder,
} from "./glb-anim";
import { isGltfModelBytes } from "./model-mesh";
import { syncAuthoredIllumination } from "./scene-illumination";
import {
  applyEditorBillboardFromActor,
  createEditorBillboard,
  editorBillboardKind,
  isEditorBillboardMesh,
  lightBillboardIcon,
  parseEditorBillboardIcon,
  syncEditorBillboardParentScale,
  type EditorBillboardIcon,
} from "./editor-billboard";
import { createSpriteQuad } from "./sprite-quad";
import { createTilemapMeshes, worldTileSize } from "./tilemap-mesh";
import { GIZMO_AXIS_COLORS } from "./gizmo-host";
import { createSkyboxMeshForFaces, isSkyboxMesh } from "./skybox";
import { createColliderVisualMesh, isColliderVisualMesh } from "./collider-visual";
import { GRID_MESH_NAME } from "./editor-grid";
import {
  BLOCKING_VOLUME_COLOR,
  createEditorVolumeMesh,
  isEditorVolumeMesh,
  NAV_BLOCKER_VOLUME_COLOR,
  type EditorVolumeKind,
} from "./editor-volume";
import { parseColliderProperties } from "@babylonslate/physics";
import { describeUiControls } from "@babylonslate/ui-runtime";
import { createText3DMesh } from "./text3d-mesh";
import {
  attachMeshGui,
  createWidgetPlane,
  createWidgetVisualMesh,
  resolveWidgetBitmapSize,
} from "./widget-gui";
import {
  applyWorldVisualGroup,
  RENDERING_GROUP,
} from "./sorting";
import { applyUiControls } from "./ui-apply";

/** Editor meshes are named so picking can map a hit back to an actor id. */
export const EDITOR_ACTOR_MESH_PREFIX = "editorActor:";

/** Child visual meshes: `editorActor:<actorId>|<componentId>`. */
export const EDITOR_COMPONENT_MESH_SEP = "|";

/** Hidden volumetric collider on origin-root actors so tap pick hits a volume, not a thin billboard. */
export const EDITOR_ORIGIN_PICK_DIAMETER = 0.75;

export function editorMeshName(actorId: string): string {
  return `${EDITOR_ACTOR_MESH_PREFIX}${actorId}`;
}

export function editorComponentMeshName(
  actorId: string,
  componentId: string,
): string {
  return `${EDITOR_ACTOR_MESH_PREFIX}${actorId}${EDITOR_COMPONENT_MESH_SEP}${componentId}`;
}

export function actorIdFromMeshName(meshName: string): string | null {
  if (!meshName.startsWith(EDITOR_ACTOR_MESH_PREFIX)) return null;
  const rest = meshName.slice(EDITOR_ACTOR_MESH_PREFIX.length);
  const pipe = rest.indexOf(EDITOR_COMPONENT_MESH_SEP);
  if (pipe >= 0) return rest.slice(0, pipe);
  // Chunk children are `editorActor:<id>:<layer>:<cx>:<cy>` plus optional
  // `:aN` atlas suffix and `:anim`.
  const chunk =
    /^(.*):([^:]+):(-?\d+):(-?\d+)(?::a\d+)?(?::anim)?$/.exec(rest);
  return chunk ? chunk[1]! : rest;
}

export function clearSceneMeshes(scene: Scene): void {
  scene.meshes.slice().forEach((mesh) => {
    if (mesh.name !== "__root__") {
      mesh.dispose();
    }
  });
}

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
  const material = new StandardMaterial(`${name}-pivot`, scene);
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
    kind === "convex" ||
    kind === "mesh"
  ) {
    return "3d";
  }
  return null;
}

function stringProp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const VISUAL_COMPONENT_CLASS_IDS = new Set([
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "LightComponent",
  "CameraComponent",
  "AudioComponent",
  "SkyboxComponent",
  "Text3DComponent",
  "WidgetComponent",
  "ParticleComponent",
  "ColliderComponent",
  "NavMeshComponent",
  "NavMeshBlockerComponent",
  "BlockingVolumeComponent",
]);

const SURFACE_COMPONENT_CLASS_IDS = new Set([
  "MeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "SkyboxComponent",
  "Text3DComponent",
  "WidgetComponent",
]);

export const EDITOR_HELPER_BILLBOARD_ID = "billboard";

function visualComponentsOf(actor: SerializedActor): SerializedComponent[] {
  return actor.components.filter((component) =>
    VISUAL_COMPONENT_CLASS_IDS.has(component.classId),
  );
}

export function isIdentitySerializedTransform(
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

function isBillboardComponent(component: SerializedComponent): boolean {
  return (
    component.classId === "LightComponent" ||
    component.classId === "CameraComponent" ||
    component.classId === "AudioComponent" ||
    component.classId === "ParticleComponent" ||
    component.classId === "NavMeshComponent"
  );
}

function hasSurfaceVisual(actor: SerializedActor): boolean {
  return actor.components.some((component) =>
    SURFACE_COMPONENT_CLASS_IDS.has(component.classId),
  );
}

export function helperBillboardIconOf(
  actor: SerializedActor,
): EditorBillboardIcon | null {
  if (hasSurfaceVisual(actor)) return null;
  const light = actor.components.find(
    (component) => component.classId === "LightComponent",
  );
  if (light) return lightBillboardIcon(light.properties.lightKind);
  if (actor.components.some((component) => component.classId === "CameraComponent")) {
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

export function needsOriginRoot(actor: SerializedActor): boolean {
  const visuals = visualComponentsOf(actor);
  return (
    helperBillboardIconOf(actor) !== null ||
    visuals.length > 1 ||
    visuals.some((component) => !isIdentitySerializedTransform(component.transform)) ||
    visuals.some(isBillboardComponent) ||
    visuals.some((component) => component.classId === "ColliderComponent") ||
    visuals.some(
      (component) =>
        component.classId === "NavMeshBlockerComponent" ||
        component.classId === "BlockingVolumeComponent",
    )
  );
}

function componentVisualKind(component: SerializedComponent): string {
  const asset = stringProp(component.properties.assetGuid) ?? "";
  if (component.classId === "MeshComponent") {
    const kind =
      typeof component.properties.meshKind === "string"
        ? component.properties.meshKind
        : "box";
    return `mesh:${kind}:${asset}`;
  }
  if (component.classId === "SpriteComponent") return `sprite:${asset}`;
  if (component.classId === "TilemapComponent") return `tilemap:${asset}`;
  if (component.classId === "LightComponent") {
    return editorBillboardKind(lightBillboardIcon(component.properties.lightKind));
  }
  if (component.classId === "CameraComponent") return editorBillboardKind("camera");
  if (component.classId === "AudioComponent") return editorBillboardKind("audio");
  if (component.classId === "SkyboxComponent") {
    const size = parseSkyboxSize(component.properties.size);
    const faces = parseSkyboxFaces(component.properties.faces);
    return `skybox:${size}:${SKYBOX_FACE_KEYS.map((key) => faces[key] ?? "").join(",")}`;
  }
  if (component.classId === "Text3DComponent") {
    const parsed = parseText3DProperties(component.properties);
    return `text3d:${parsed.text}:${parsed.size}:${parsed.color.join(",")}:${parsed.fontAssetGuid ?? ""}`;
  }
  if (component.classId === "WidgetComponent") {
    const parsed = parseWidgetComponentProperties(component.properties);
    return `widget:${parsed.uiAssetGuid ?? ""}:${parsed.twoSided ? 1 : 0}:${parsed.width}:${parsed.height}`;
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
export function actorVisualFingerprint(actor: SerializedActor): string {
  const visuals = visualComponentsOf(actor);
  if (visuals.length === 0) {
    const mode = needsOriginRoot(actor) ? "origin" : "single";
    return `${mode}:${editorMeshKindOf(actor) ?? ""}`;
  }
  const mode = needsOriginRoot(actor) ? "origin" : "single";
  return `${mode}:${visuals
    .map((component) => `${component.id}:${componentVisualKind(component)}`)
    .join(";")}`;
}

function createSpriteComponentMesh(
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
  return mesh;
}

function createWidgetComponentMesh(
  scene: Scene,
  name: string,
  component: SerializedComponent,
  assets?: MeshAssetContext,
): Mesh {
  const parsed = parseWidgetComponentProperties(component.properties);
  const document = parsed.uiAssetGuid
    ? assets?.uiDocuments?.get(parsed.uiAssetGuid)
    : undefined;
  const bitmap = document
    ? resolveWidgetBitmapSize(document)
    : { width: 400, height: 300 };
  const mesh = createWidgetVisualMesh(scene, name, parsed, bitmap);
  if (document) {
    const attached = attachMeshGui(mesh, {
      name: `${name}:gui`,
      twoSided: parsed.twoSided,
      interactive: false,
      bitmap,
    });
    applyUiControls(
      attached.host,
      describeUiControls(document, {
        parentSize: bitmap,
        applySafeArea: false,
      }),
    );
    mesh.onDisposeObservable.addOnce(() => attached.dispose());
    mesh.sideOrientation = parsed.twoSided ? Mesh.DOUBLESIDE : Mesh.FRONTSIDE;
    if (mesh.material) {
      mesh.material.backFaceCulling = !parsed.twoSided;
    }
  }
  return mesh;
}

function createTilemapComponentMesh(
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
    return mesh;
  }
  return createPrimitiveMesh(scene, name, "tilemap");
}

/** Resolve the editor mesh kind, including billboard helpers for location-only components. */
export function editorMeshKindOf(actor: SerializedActor): string | null {
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
  if (actor.components.some((component) => component.classId === "LightComponent")) {
    const light = actor.components.find(
      (component) => component.classId === "LightComponent",
    );
    return editorBillboardKind(lightBillboardIcon(light?.properties.lightKind));
  }
  if (actor.components.some((component) => component.classId === "CameraComponent")) {
    return editorBillboardKind("camera");
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
  const widgetComponent = actor.components.find(
    (component) => component.classId === "WidgetComponent",
  );
  if (widgetComponent) return componentVisualKind(widgetComponent);
  if (
    actor.components.some((component) => component.classId === "ParticleComponent")
  ) {
    return editorBillboardKind("particle");
  }
  if (actor.components.some((component) => component.classId === "NavMeshComponent")) {
    return editorBillboardKind("navmesh");
  }
  return editorBillboardKind(helperBillboardIconOf(actor) ?? "default");
}

/** Build a Babylon mesh for one visual component. */
export function createMeshForComponent(
  scene: Scene,
  name: string,
  actor: SerializedActor,
  component: SerializedComponent,
  assets?: MeshAssetContext,
): Mesh {
  if (component.classId === "SpriteComponent") {
    return createSpriteComponentMesh(scene, name, component, assets);
  }
  if (component.classId === "TilemapComponent") {
    return createTilemapComponentMesh(scene, name, component, assets);
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
  if (component.classId === "CameraComponent") {
    return createEditorBillboard(scene, name, "camera");
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
    return createText3DMesh(scene, name, component.properties, assets);
  }
  if (component.classId === "WidgetComponent") {
    return createWidgetComponentMesh(scene, name, component, assets);
  }
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
      parseColliderProperties(component.properties, world).shape,
    );
  }
  const assetGuid = stringProp(component.properties.assetGuid);
  if (assetGuid) {
    return createModelActorRoot(scene, name);
  }
  const meshKind =
    typeof component.properties.meshKind === "string"
      ? component.properties.meshKind
      : null;
  return createPrimitiveMesh(scene, name, meshKind);
}

function createOriginRootMesh(scene: Scene, actor: SerializedActor): Mesh {
  const root = MeshBuilder.CreateSphere(
    editorMeshName(actor.id),
    { diameter: EDITOR_ORIGIN_PICK_DIAMETER },
    scene,
  );
  root.metadata = {
    ...(root.metadata ?? {}),
    editorActorOrigin: true,
    editorPickProxy: true,
  };
  root.visibility = 0;
  root.isVisible = actor.visible;
  root.isPickable = !actor.locked;
  return root;
}

function visualIsPickable(mesh: Mesh, locked: boolean): boolean {
  if (isSkyboxMesh(mesh) || isColliderVisualMesh(mesh)) return false;
  if (isEditorVolumeMesh(mesh)) return !locked;
  return !locked;
}

function parentVisualMeshId(
  component: SerializedComponent,
  visuals: ReadonlyMap<string, Mesh>,
  componentsById: ReadonlyMap<string, SerializedComponent>,
): string | null {
  let parentId = component.parentId ?? null;
  while (parentId) {
    if (visuals.has(parentId)) return parentId;
    parentId = componentsById.get(parentId)?.parentId ?? null;
  }
  return null;
}

function createActorOriginHierarchy(
  scene: Scene,
  actor: SerializedActor,
  assets?: MeshAssetContext,
): Mesh {
  const root = createOriginRootMesh(scene, actor);
  const visuals = visualComponentsOf(actor);
  const componentsById = new Map(
    actor.components.map((component) => [component.id, component]),
  );
  const meshes = new Map<string, Mesh>();
  for (const component of visuals) {
    const mesh = createMeshForComponent(
      scene,
      editorComponentMeshName(actor.id, component.id),
      actor,
      component,
      assets,
    );
    applySerializedTransform(
      mesh,
      component.transform ?? identitySerializedTransform(),
    );
    mesh.isVisible = actor.visible;
    mesh.isPickable = visualIsPickable(mesh, actor.locked);
    meshes.set(component.id, mesh);
  }
  for (const component of visuals) {
    const mesh = meshes.get(component.id);
    if (!mesh) continue;
    const parentId = parentVisualMeshId(component, meshes, componentsById);
    mesh.parent = parentId ? (meshes.get(parentId) ?? root) : root;
  }
  const helperIcon = helperBillboardIconOf(actor);
  if (helperIcon && !visuals.some(isBillboardComponent)) {
    const billboard = createEditorBillboard(
      scene,
      editorComponentMeshName(actor.id, EDITOR_HELPER_BILLBOARD_ID),
      helperIcon,
    );
    applyEditorBillboardFromActor(billboard, actor);
    billboard.isVisible = actor.visible;
    billboard.isPickable = visualIsPickable(billboard, actor.locked);
    billboard.parent = root;
    syncEditorBillboardParentScale(billboard);
  }
  return root;
}

/** Build the Babylon mesh for an actor's first renderable component. */
export function createActorMesh(
  scene: Scene,
  actor: SerializedActor,
  assets?: MeshAssetContext,
): Mesh {
  if (needsOriginRoot(actor)) {
    return createActorOriginHierarchy(scene, actor, assets);
  }
  const name = editorMeshName(actor.id);
  const meshComponent = actor.components.find(
    (component) => component.classId === "MeshComponent",
  );
  const spriteComponent = actor.components.find(
    (component) => component.classId === "SpriteComponent",
  );
  const tilemapComponent = actor.components.find(
    (component) => component.classId === "TilemapComponent",
  );
  const skyboxComponent = actor.components.find(
    (component) => component.classId === "SkyboxComponent",
  );
  const text3dComponent = actor.components.find(
    (component) => component.classId === "Text3DComponent",
  );
  const widgetComponent = actor.components.find(
    (component) => component.classId === "WidgetComponent",
  );
  if (!meshComponent && spriteComponent) {
    return createSpriteComponentMesh(scene, name, spriteComponent, assets);
  }
  if (!meshComponent && !spriteComponent && tilemapComponent) {
    return createTilemapComponentMesh(scene, name, tilemapComponent, assets);
  }
  if (!meshComponent && !spriteComponent && !tilemapComponent && skyboxComponent) {
    return createMeshForComponent(scene, name, actor, skyboxComponent, assets);
  }
  if (
    !meshComponent &&
    !spriteComponent &&
    !tilemapComponent &&
    !skyboxComponent &&
    text3dComponent
  ) {
    return createMeshForComponent(scene, name, actor, text3dComponent, assets);
  }
  if (
    !meshComponent &&
    !spriteComponent &&
    !tilemapComponent &&
    !skyboxComponent &&
    !text3dComponent &&
    widgetComponent
  ) {
    return createMeshForComponent(scene, name, actor, widgetComponent, assets);
  }
  const assetGuid = stringProp(meshComponent?.properties.assetGuid);
  if (assetGuid) {
    return createModelActorRoot(scene, name);
  }
  const icon = parseEditorBillboardIcon(editorMeshKindOf(actor));
  if (icon) {
    const mesh = createEditorBillboard(scene, name, icon);
    applyEditorBillboardFromActor(mesh, actor);
    return mesh;
  }
  const meshKind =
    typeof meshComponent?.properties.meshKind === "string"
      ? meshComponent.properties.meshKind
      : null;
  return createPrimitiveMesh(scene, name, meshKind);
}

function childMeshesOf(mesh: Mesh): Mesh[] {
  return mesh.getChildMeshes().filter((child): child is Mesh => child instanceof Mesh);
}

export function applySerializedTransform(
  mesh: Mesh,
  transform: SerializedTransform,
): void {
  const [px, py, pz] = transform.position;
  const [rx, ry, rz, rw] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  mesh.position.set(px, py, pz);
  if (!mesh.rotationQuaternion) {
    mesh.rotationQuaternion = new Quaternion(rx, ry, rz, rw);
  } else {
    mesh.rotationQuaternion.set(rx, ry, rz, rw);
  }
  mesh.scaling.set(sx, sy, sz);
}

export function isEditorActorOrigin(mesh: Mesh): boolean {
  return Boolean(
    (mesh.metadata as { editorActorOrigin?: boolean } | null)?.editorActorOrigin,
  );
}

function applyModelPlaceholderVisibility(mesh: Mesh, actor: SerializedActor): void {
  hideModelPlaceholder(mesh);
  for (const child of mesh.getChildMeshes()) {
    if (!(child instanceof Mesh)) continue;
    child.isVisible = actor.visible;
    child.isPickable = visualIsPickable(child, actor.locked);
  }
}

export function applyActorTransform(mesh: Mesh, actor: SerializedActor): void {
  if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix();
  applySerializedTransform(mesh, actor.transform);
  const origin = isEditorActorOrigin(mesh);
  if (origin) {
    mesh.visibility = 0;
  }
  applyWorldVisualGroup(mesh, actor);
  if (isSkyboxMesh(mesh)) {
    mesh.renderingGroupId = RENDERING_GROUP.background;
  }
  if (isEditorModelPlaceholder(mesh)) {
    applyModelPlaceholderVisibility(mesh, actor);
    return;
  }
  mesh.isVisible = actor.visible;
  mesh.isPickable = visualIsPickable(mesh, actor.locked);
  if (!origin) return;
  for (const child of childMeshesOf(mesh)) {
    if (isEditorBillboardMesh(child)) {
      syncEditorBillboardParentScale(child);
    }
    if (isEditorModelPlaceholder(child)) {
      applyModelPlaceholderVisibility(child, actor);
      continue;
    }
    if (!child.name.includes(EDITOR_COMPONENT_MESH_SEP)) continue;
    const afterPipe = child.name.slice(
      child.name.indexOf(EDITOR_COMPONENT_MESH_SEP) + 1,
    );
    if (afterPipe.includes(":")) continue;
    child.isVisible = actor.visible;
    child.isPickable = visualIsPickable(child, actor.locked);
  }
}

export function applyComponentChildTransforms(
  mesh: Mesh,
  actor: SerializedActor,
): void {
  if (!isEditorActorOrigin(mesh)) return;
  for (const component of visualComponentsOf(actor)) {
    const childName = editorComponentMeshName(actor.id, component.id);
    const child = childMeshesOf(mesh).find((entry) => entry.name === childName);
    if (!child) continue;
    applySerializedTransform(
      child,
      component.transform ?? identitySerializedTransform(),
    );
  }
}

function isEditorPickProxy(mesh: Mesh): boolean {
  return Boolean(
    (mesh.metadata as { editorPickProxy?: boolean } | null)?.editorPickProxy,
  );
}

export function visualMeshesOfActorRoot(mesh: Mesh): Mesh[] {
  if (!isEditorActorOrigin(mesh)) return [mesh];
  const parts = childMeshesOf(mesh).filter((child) => {
    if (isEditorPickProxy(child) || isEditorActorOrigin(child)) return false;
    if (!child.name.includes(EDITOR_COMPONENT_MESH_SEP)) return false;
    const afterPipe = child.name.slice(
      child.name.indexOf(EDITOR_COMPONENT_MESH_SEP) + 1,
    );
    return !afterPipe.includes(":");
  });
  return parts.length > 0 ? parts : [mesh];
}

export function shouldFreezeStaticWorldMatrix(mesh: Mesh): boolean {
  if (mesh.infiniteDistance) return false;
  if (isSkyboxMesh(mesh)) return false;
  if (mesh.billboardMode !== Mesh.BILLBOARDMODE_NONE) return false;
  if (mesh.name === GRID_MESH_NAME) return false;
  if (mesh.alwaysSelectAsActiveMesh) return false;
  return true;
}

export function freezeStaticActorWorldMatrix(root: Mesh): void {
  for (const mesh of [root, ...visualMeshesOfActorRoot(root)]) {
    if (!shouldFreezeStaticWorldMatrix(mesh)) continue;
    mesh.freezeWorldMatrix();
  }
}

export function unfreezeActorWorldMatrix(root: Mesh): void {
  for (const mesh of [root, ...visualMeshesOfActorRoot(root)]) {
    if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix();
  }
}

/** GLB instantiate target: MeshComponent child under an origin, else the actor root. */
export function editorModelLoadTarget(
  root: Mesh,
  actor: SerializedActor,
): Mesh {
  const component = actor.components.find((entry) => {
    if (entry.classId !== "MeshComponent") return false;
    const guid = entry.properties.assetGuid;
    return typeof guid === "string" && guid.length > 0;
  });
  if (!component || !isEditorActorOrigin(root)) return root;
  const name = editorComponentMeshName(actor.id, component.id);
  return visualMeshesOfActorRoot(root).find((mesh) => mesh.name === name) ?? root;
}

/** Full rebuild of the editor scene; `EditorSceneSync` does incremental work. */
export function applySceneToBabylonScene(
  scene: Scene,
  sceneData: SerializedScene,
  assets?: MeshAssetContext,
): void {
  clearSceneMeshes(scene);

  const meshes = new Map<string, Mesh>();
  const loadBinding = {
    slotAnimEpoch: new Map<number, number>(),
    slotAnimationGroups: new Map(),
    slotAnimLoads: new Map<number, Promise<void>>(),
    modelBytes: assets?.modelBytes,
    modelPayloads: assets?.modelPayloads,
    modelClipAnimationGuids: assets?.modelClipAnimationGuids,
    retargetAnimationLoads: assets?.retargetAnimationLoads,
  };
  let loadSlot = 0;
  for (const actor of sceneData.actors) {
    const mesh = createActorMesh(scene, actor, assets);
    applyActorTransform(mesh, actor);
    meshes.set(actor.id, mesh);
    const guid = actor.components.find(
      (component) => component.classId === "MeshComponent",
    )?.properties.assetGuid;
    const bytes =
      typeof guid === "string" ? assets?.modelBytes?.get(guid) : undefined;
    if (typeof guid === "string" && bytes && isGltfModelBytes(bytes)) {
      const placeholder = editorModelLoadTarget(mesh, actor);
      void beginSlotModelAnimLoad(
        scene,
        loadBinding,
        ++loadSlot,
        guid,
        bytes,
        placeholder,
        () => applyActorTransform(mesh, actor),
      );
    }
  }

  for (const actor of sceneData.actors) {
    if (!actor.parentId) continue;
    const mesh = meshes.get(actor.id);
    const parent = meshes.get(actor.parentId);
    if (mesh && parent) {
      mesh.parent = parent;
    }
  }

  for (const mesh of meshes.values()) {
    freezeStaticActorWorldMatrix(mesh);
  }

  syncAuthoredIllumination(scene, sceneData, {
    stealActiveCamera: true,
    applyClearColor: true,
    assets,
  });
}

export function countSceneMeshes(scene: Scene): number {
  return scene.meshes.filter((mesh) => mesh.name !== "__root__").length;
}

export function toVector3(value: [number, number, number]): Vector3 {
  return new Vector3(value[0], value[1], value[2]);
}

import { Mesh, MeshBuilder, Quaternion, Scene, Vector3, type Matrix, type TransformNode } from "@babylonjs/core";
import { resolveOverlayLayout } from "@haptic/core";
import { applyEditorLayoutClips } from "./overlay-layout-render";
import { bindEditorCable, configureCableMesh, findEditorCableMesh, hasEditorCableMeshes, pruneEditorCables, updateCablePreview } from "./cable-mesh";
import { authoredActorMatrices, authoredComponentActorTransform, authoredTransformMatrix } from "./authored-transform-matrices";
import { syncFogVolumeGuideAttachments } from "./fog-volume-guide";
import type { SerializedActor, SerializedComponent, SerializedScene, SerializedTransform } from "@haptic/core";
import { sceneShadowController } from "./shadow-controller";
import { isUIControl2DClass } from "@haptic/core";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import { supportsOverlayVisualStyle } from "@haptic/core";
import {
  identitySerializedTransform,
  isSceneLayerAnchorActor,
  fogVolumeBindings,
  reflectionProbeBindings,
  parseCableProperties,
} from "@haptic/core";
import type { MeshAssetContext } from "./mesh-assets";
import {
  beginSlotModelAnimLoad,
  createModelActorRoot,
  hideModelPlaceholder,
  isEditorModelPlaceholder,
} from "./glb-anim";
import { installModelSources } from "./mesh-assets";
import { syncAuthoredIllumination } from "./scene-illumination";
import {
  applyEditorBillboardFromActor,
  applyEditorBillboardPass,
  createEditorBillboard,
  isEditorBillboardMesh,
  parseEditorBillboardIcon,
  syncEditorBillboardParentScale,
} from "./editor-billboard";
import { isSkyboxMesh } from "./skybox";
import { isColliderVisualMesh } from "./collider-visual";
import { GRID_MESH_NAME } from "./editor-grid";
import { isEditorCameraModel } from "./editor-camera-model";
import { attachmentParentFor } from "./spring-arm";
import { refreshText2DMaterials, text2DBitmapBytes } from "./text2d-mesh";
import { applyAuthoredMaterialInstance } from "./authored-material-instance";
import {
  applyWorldVisualGroup,
  RENDERING_GROUP,
} from "./sorting";
import {
  helperBillboardIconOf, isBillboardComponent, needsOriginRoot, SceneActorIndex, skipOverlayButtonVisual, stringProp,
  VISUAL_COMPONENT_CLASS_IDS, visualComponentsOf, type SceneActorSource,
} from "./scene-visual-classify";
import { editorMeshKindOf } from "./scene-visual-fingerprint";
import {
  applyAuthoredComponentSorting, createMeshForComponent, createPrimitiveMesh, createSpriteComponentMesh,
  createTilemapComponentMesh,
} from "./scene-component-mesh";
import { attachMeshCollisionDashes } from "./mesh-collision-dashes";

// Classification, fingerprints, the per-component mesh factory and collision dashes live in their own modules; this
// stays their stable import path.
export {
  hasSurfaceVisual, helperBillboardIconOf, needsOriginRoot, SceneActorIndex, type SceneActorSource,
} from "./scene-visual-classify";
export { actorVisualFingerprint, editorMeshKindOf } from "./scene-visual-fingerprint";
export { createMeshForComponent, createPrimitiveMesh } from "./scene-component-mesh";
export { syncMeshCollisionDashes } from "./mesh-collision-dashes";

/** Editor meshes are named so picking can map a hit back to an actor id. */
export const EDITOR_ACTOR_MESH_PREFIX = "editorActor:";

/** Child visual meshes: `editorActor:<actorId>|<componentId>`. */
export const EDITOR_COMPONENT_MESH_SEP = "|";

/** Hidden volumetric collider on origin-root actors so tap pick hits a volume, not a thin billboard. */
export const EDITOR_ORIGIN_PICK_DIAMETER = 0.75;

export const EDITOR_HELPER_BILLBOARD_ID = "billboard";

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
  if (
    (mesh.metadata as { editorUnpickable?: boolean } | null)?.editorUnpickable
  ) {
    return false;
  }
  if (isSkyboxMesh(mesh) || isColliderVisualMesh(mesh)) return false;
  return !locked;
}

function parentVisualMeshId(
  component: SerializedComponent,
  visuals: ReadonlyMap<string, Mesh>,
  componentsById: ReadonlyMap<string, SerializedComponent>,
): string | null {
  const visited = new Set<string>();
  let parentId = component.parentId ?? null;
  while (parentId && !visited.has(parentId)) {
    if (visuals.has(parentId)) return parentId;
    visited.add(parentId);
    parentId = componentsById.get(parentId)?.parentId ?? null;
  }
  return null;
}

function cableVisualTransform(actor: SerializedActor, component: SerializedComponent): SerializedTransform {
  const local = component.transform ?? identitySerializedTransform();
  if (component.classId !== "CableComponent" || !component.parentId) return local;
  const byId = new Map(actor.components.map((entry) => [entry.id, entry]));
  const matrix = authoredTransformMatrix(local);
  const visited = new Set([component.id]);
  let parent = byId.get(component.parentId);
  // A non-visual SceneComponent has no Babylon node: retain its transform in
  // the cable's local transform up to the nearest actual visual parent.
  while (parent && !VISUAL_COMPONENT_CLASS_IDS.has(parent.classId) && !visited.has(parent.id)) {
    visited.add(parent.id);
    matrix.multiplyToRef(authoredTransformMatrix(parent.transform ?? identitySerializedTransform()), matrix);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
  if (!matrix.decompose(scale, rotation, position)) return local;
  return { position: [position.x, position.y, position.z], rotation: [rotation.x, rotation.y, rotation.z, rotation.w], scale: [scale.x, scale.y, scale.z] };
}

function createActorOriginHierarchy(
  scene: Scene,
  actor: SerializedActor,
  assets?: MeshAssetContext,
  allActors?: SceneActorSource,
): Mesh {
  const root = createOriginRootMesh(scene, actor);
  const visuals = visualComponentsOf(actor, allActors);
  const componentsById = new Map(
    actor.components.map((component) => [component.id, component]),
  );
  const meshes = new Map<string, Mesh>();
  let retainedBitmapBytes = assets?.retainedTextBitmapBytes ?? 0;
  try {
    for (const component of visuals) {
      const mesh = createMeshForComponent(
        scene,
        editorComponentMeshName(actor.id, component.id),
        actor,
        component,
        { ...assets, retainedTextBitmapBytes: retainedBitmapBytes },
        allActors,
      );
      mesh.parent = root;
      retainedBitmapBytes += text2DBitmapBytes(mesh);
      applySerializedTransform(
        mesh,
        cableVisualTransform(actor, component),
      );
      mesh.isVisible = actor.visible;
      mesh.isPickable = visualIsPickable(mesh, actor.locked);
      meshes.set(component.id, mesh);
    }
    const fogBindings = new Map<string, { transforms: SerializedTransform[]; error?: string }>(
    [...fogVolumeBindings(actor.components), ...reflectionProbeBindings(actor.components)].map((binding) => [binding.id, binding]));
    for (const component of visuals) {
      const mesh = meshes.get(component.id);
      if (!mesh) continue;
      const fogBinding = fogBindings.get(component.id);
      if (fogBinding) {
        syncFogVolumeGuideAttachments(mesh, root, fogBinding, actor.visible);
        continue;
      }
      const parentId = parentVisualMeshId(component, meshes, componentsById);
      const parent = parentId ? meshes.get(parentId) : undefined;
      // The link that would close a component parent cycle attaches to the root.
      const socket = parent ? attachmentParentFor(parent) : undefined;
      mesh.parent = socket && socket !== mesh && !socket.isDescendantOf(mesh) ? socket : root;
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
  } catch (error) {
    root.dispose();
    throw error;
  }
}

/** Build the Babylon mesh for an actor's first renderable component. */
export function createActorMesh(
  scene: Scene,
  actor: SerializedActor,
  assets?: MeshAssetContext,
  allActors?: SceneActorSource,
): Mesh {
  const mesh = createUnboundActorMesh(scene, actor, assets, allActors);
  try {
    applyAuthoredActorMaterialInstances(mesh, actor, assets);
    return mesh;
  } catch (error) { mesh.dispose(); throw error; }
}

/** Reused by full loads, incremental edits and model adoption. */
export function applyAuthoredActorMaterialInstances(
  root: Mesh,
  actor: SerializedActor,
  assets?: MeshAssetContext,
  onPublished?: () => void,
): void {
  const parts = isEditorActorOrigin(root) ? visualMeshesOfActorRoot(root) : [root];
  for (const component of visualComponentsOf(actor)) {
    const visual = isEditorActorOrigin(root)
      ? parts.find((mesh) => mesh.name === editorComponentMeshName(actor.id, component.id)) : root;
    if (!visual) continue;
    const text = component.classId === "2DTextComponent" || component.classId === "2DRichTextComponent";
    applyAuthoredMaterialInstance(visual, component, assets, {
      unlit: text || component.classId.startsWith("2D"), onPublished,
      ...(text ? { apply: (material: import("@babylonjs/core").Material) => refreshText2DMaterials(visual, {
        ...assets, resolveMaterial: (guid, options) => guid === component.properties.materialGuid
          ? material : assets?.resolveMaterial?.(guid, options) ?? null,
      }) } : {}),
    });
  }
}

function createUnboundActorMesh(
  scene: Scene,
  actor: SerializedActor,
  assets?: MeshAssetContext,
  allActors?: SceneActorSource,
): Mesh {
  if (isSceneLayerAnchorActor(actor)) {
    const root = new Mesh(editorMeshName(actor.id), scene);
    root.metadata = { editorActorOrigin: true, editorUnpickable: true };
    root.isPickable = false;
    return root;
  }
  if (needsOriginRoot(actor, allActors)) {
    return createActorOriginHierarchy(scene, actor, assets, allActors);
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
  const text3dComponent = visualComponentsOf(actor, allActors).find(
    (component) => component.classId === "Text3DComponent",
  );
  const text2dComponent = actor.components.find(
    (component) =>
      component.classId === "2DTextComponent" ||
      component.classId === "2DRichTextComponent",
  );
  const overlayPlane = visualComponentsOf(actor, allActors).find(
    (component) =>
      isUIControl2DClass(component.classId) ||
      component.classId === "2DJoystickComponent" ||
      component.classId === "2DPainterComponent" ||
      component.classId === "2DTextureComponent" ||
      component.classId === "2DMaterialComponent" ||
      component.classId === "2DPanelComponent" ||
      component.classId === "2DButtonComponent",
  );
  if (!meshComponent) {
    if (spriteComponent) {
      return createSpriteComponentMesh(scene, name, spriteComponent, assets);
    }
    if (tilemapComponent) {
      return createTilemapComponentMesh(scene, name, tilemapComponent, assets);
    }
    if (skyboxComponent) {
      return createMeshForComponent(scene, name, actor, skyboxComponent, assets);
    }
    if (text3dComponent) {
      return createMeshForComponent(scene, name, actor, text3dComponent, assets, allActors);
    }
    if (text2dComponent) {
      return createMeshForComponent(scene, name, actor, text2dComponent, assets);
    }
    if (overlayPlane) {
      return createMeshForComponent(scene, name, actor, overlayPlane, assets);
    }
    if (
      skipOverlayButtonVisual(actor, allActors) &&
      visualComponentsOf(actor, allActors).length === 0 &&
      helperBillboardIconOf(actor) === null
    ) {
      const hidden = createOriginRootMesh(scene, actor);
      hidden.metadata = { ...(hidden.metadata ?? {}), editorUnpickable: true };
      hidden.isPickable = false;
      return hidden;
    }
  }
  const assetGuid = stringProp(meshComponent?.properties.assetGuid);
  if (assetGuid) {
    const root = createModelActorRoot(scene, name);
    if (meshComponent) attachMeshCollisionDashes(root, meshComponent, assets);
    return root;
  }
  const icon = parseEditorBillboardIcon(editorMeshKindOf(actor, assets, allActors));
  if (icon) {
    const mesh = createEditorBillboard(scene, name, icon);
    applyEditorBillboardFromActor(mesh, actor);
    return mesh;
  }
  const meshKind =
    typeof meshComponent?.properties.meshKind === "string"
      ? meshComponent.properties.meshKind
      : null;
  const primitive = createPrimitiveMesh(scene, name, meshKind);
  if (meshComponent) attachMeshCollisionDashes(primitive, meshComponent, assets);
  return primitive;
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
    // LOD levels stay unpickable; their master owns visibility and picking.
    if (!(child instanceof Mesh) || child.isBlocked) continue;
    child.isVisible = actor.visible;
    child.isPickable = visualIsPickable(child, actor.locked);
  }
}

export function applyActorTransform(mesh: Mesh, actor: SerializedActor): void {
  if (!isEditorActorOrigin(mesh)) {
    const visual = actor.components.find((entry) => supportsOverlayVisualStyle(entry.classId));
    if (visual) applyOverlayVisualStyle(mesh, visual.properties);
  }
  const component = actor.components.find((entry) => entry.classId === "MeshComponent");
  if (component && !isEditorActorOrigin(mesh)) sceneShadowController(mesh.getScene()).setParticipation(mesh, component.properties);
  if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix();
  applySerializedTransform(mesh, isSceneLayerAnchorActor(actor) ? identitySerializedTransform() : actor.transform);
  const origin = isEditorActorOrigin(mesh);
  if (origin) {
    mesh.visibility = 0;
  }
  applyWorldVisualGroup(mesh, actor);
  if (isEditorBillboardMesh(mesh)) {
    applyEditorBillboardPass(mesh);
  }
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
  const environmentRoots = new Set(actor.components
    .filter((entry) => entry.classId === "LandscapeComponent" || entry.classId === "FoliageComponent")
    .map((entry) => editorComponentMeshName(actor.id, entry.id)));
  for (const child of childMeshesOf(mesh)) {
    const environmentRoot = child.metadata?.landscapeRoot ?? child.metadata?.foliageRoot;
    if (environmentRoot && environmentRoots.has(environmentRoot.name)) {
      child.isVisible = actor.visible;
      child.isPickable = actor.visible && !actor.locked;
      continue;
    }
    if (isEditorBillboardMesh(child)) {
      applyEditorBillboardPass(child);
      syncEditorBillboardParentScale(child);
    }
    if (isEditorModelPlaceholder(child)) {
      applyModelPlaceholderVisibility(child, actor);
      continue;
    }
    if (!isDirectComponentPart(child.name)) continue;
    child.isVisible = actor.visible;
    child.isPickable = visualIsPickable(child, actor.locked);
  }
}

export function applyComponentChildTransforms(
  mesh: Mesh,
  actor: SerializedActor,
): void {
  if (!isEditorActorOrigin(mesh)) return;
  const fogBindings = new Map<string, { transforms: SerializedTransform[]; error?: string }>(
    [...fogVolumeBindings(actor.components), ...reflectionProbeBindings(actor.components)].map((binding) => [binding.id, binding]));
  for (const component of visualComponentsOf(actor)) {
    const childName = editorComponentMeshName(actor.id, component.id);
    const child = childMeshesOf(mesh).find((entry) => entry.name === childName);
    if (!child) continue;
    if (supportsOverlayVisualStyle(component.classId)) applyOverlayVisualStyle(child, component.properties);
    if ((isEditorCameraModel(child) || component.classId === "CableComponent") && child.isWorldMatrixFrozen) child.unfreezeWorldMatrix();
    if (component.classId === "MeshComponent" || component.classId === "CableComponent") sceneShadowController(mesh.getScene()).setParticipation(child, component.properties);
    applySerializedTransform(
      child,
      cableVisualTransform(actor, component),
    );
    const fogBinding = fogBindings.get(component.id);
    if (fogBinding) syncFogVolumeGuideAttachments(child, mesh, fogBinding, actor.visible);
  }
}

/** A component's own visual (`...|<componentId>`), not a `:`-suffixed sub-part. */
function isDirectComponentPart(name: string): boolean {
  const pipe = name.indexOf(EDITOR_COMPONENT_MESH_SEP);
  return pipe >= 0 && !name.slice(pipe + 1).includes(":");
}

function isEditorPickProxy(mesh: Mesh): boolean {
  return Boolean(
    (mesh.metadata as { editorPickProxy?: boolean } | null)?.editorPickProxy,
  );
}

export function applyActorComponentSorting(root: Mesh, actor: SerializedActor, layers: readonly string[]): void {
  for (const component of actor.components) {
    if (component.classId !== "SpriteComponent" && component.classId !== "TilemapComponent") continue;
    const target = isEditorActorOrigin(root)
      ? visualMeshesOfActorRoot(root).find((mesh) => mesh.name === editorComponentMeshName(actor.id, component.id))
      : root;
    if (!target) continue;
    applyAuthoredComponentSorting(target, component, layers);
    const groupId = `${actor.id}|${component.id}`;
    for (const mesh of [target, ...target.getChildMeshes(true).filter((child) => child.metadata?.tilemapLayer)]) {
      mesh.metadata = { ...(mesh.metadata ?? {}), sortingGroupId: groupId };
    }
  }
}

export function visualMeshesOfActorRoot(mesh: Mesh): Mesh[] {
  if (!isEditorActorOrigin(mesh)) return [mesh];
  const parts = childMeshesOf(mesh).filter((child) => {
    if (isEditorPickProxy(child) || isEditorActorOrigin(child)) return false;
    return isDirectComponentPart(child.name);
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

export type EditorCableSyncOptions = {
  /** Live actor roots. With `simulate`, cables bind to the editor simulation. */
  rootForActor?: (actorId: string) => TransformNode | null | undefined;
  /** Scene gravity (default `[0, -9.81, 0]`). */
  gravity?: readonly number[];
  /** Simulate in the editor render loop instead of drawing a static rest shape. */
  simulate?: boolean;
};

/**
 * Apply cable properties and endpoints after a document apply. Static callers
 * (loads, thumbnails) draw the settled rest shape; editor viewports pass
 * `simulate` and live roots so `stepEditorCables` animates the cable.
 */
export function syncEditorCablePreviews(scene: Scene, actors: readonly SerializedActor[], options: EditorCableSyncOptions = {}): void {
  const bound = options.simulate ? new Set<string>() : null;
  if (!hasEditorCableMeshes(scene)) {
    if (bound) pruneEditorCables(scene, bound);
    return;
  }
  const gravity = options.gravity ?? [0, -9.81, 0];
  const rootForActor = options.rootForActor;
  let actorsById: Map<string, SerializedActor> | null = null;
  let actorMatrix: ((actor: SerializedActor) => Matrix) | null = null;
  for (const actor of actors) for (const component of actor.components) {
    if (component.classId !== "CableComponent") continue;
    const name = editorComponentMeshName(actor.id, component.id);
    const mesh = findEditorCableMesh(scene, name, rootForActor?.(actor.id));
    if (!mesh) continue;
    const properties = parseCableProperties(component.properties);
    configureCableMesh(mesh, properties);
    actorsById ??= new Map(actors.map((entry) => [entry.id, entry]));
    const targetActor = (properties.targetActorId ? actorsById.get(properties.targetActorId) : undefined) ?? actor;
    const targetComponent = properties.targetComponentId
      ? targetActor.components.find((entry) => entry.id === properties.targetComponentId || entry.sourceId === properties.targetComponentId)
      : properties.targetActorId ? undefined : component;
    if (bound && rootForActor) {
      const self = targetComponent === component;
      const endNode = self ? mesh : rootForActor(targetActor.id);
      if (endNode && !endNode.isDisposed()) {
        const endLocal = !self && targetComponent
          ? Vector3.TransformCoordinates(Vector3.FromArray(properties.endPosition), authoredTransformMatrix(authoredComponentActorTransform(targetActor, targetComponent))).asArray()
          : properties.endPosition;
        bindEditorCable(mesh, { endNode, endLocal, gravity, endActorId: self ? undefined : targetActor.id, rootForActor });
        bound.add(name);
        continue;
      }
    }
    actorMatrix ??= authoredActorMatrices(actors);
    const target = targetComponent
      ? authoredTransformMatrix(authoredComponentActorTransform(targetActor, targetComponent)).multiply(actorMatrix(targetActor))
      : actorMatrix(targetActor);
    const cableWorld = authoredTransformMatrix(authoredComponentActorTransform(actor, component)).multiply(actorMatrix(actor));
    if (Math.abs(cableWorld.determinant()) < 1e-12) continue;
    const end = Vector3.TransformCoordinates(Vector3.FromArray(properties.endPosition), target);
    const start = Vector3.TransformCoordinates(Vector3.Zero(), cableWorld);
    updateCablePreview(mesh, [end.x, end.y, end.z], [start.x, start.y, start.z], gravity);
  }
  if (bound) pruneEditorCables(scene, bound);
}

/** Every MeshComponent that names a Model, in component order: each loads into its own placeholder. */
export function modelMeshComponentsOf(actor: SerializedActor): Array<{ component: SerializedComponent; guid: string }> {
  return actor.components.flatMap((component) => {
    const guid = component.classId === "MeshComponent" ? component.properties.assetGuid : undefined;
    return typeof guid === "string" && guid.length > 0 ? [{ component, guid }] : [];
  });
}

/** GLB instantiate target for a model MeshComponent: its child under an origin, else the actor root. */
export function editorModelLoadTarget(
  root: Mesh,
  actor: SerializedActor,
  component: SerializedComponent,
): Mesh {
  if (!isEditorActorOrigin(root)) return root;
  const name = editorComponentMeshName(actor.id, component.id);
  return visualMeshesOfActorRoot(root).find((mesh) => mesh.name === name) ?? root;
}

/** Outliner-only anchors are transparent to the renderer's spatial hierarchy. */
export function editorActorParentId(
  actor: SerializedActor,
  actorsById: ReadonlyMap<string, SerializedActor>,
): string | null {
  let parentId = actor.parentId;
  const visited = new Set([actor.id]);
  while (parentId && !visited.has(parentId)) {
    const parent = actorsById.get(parentId);
    if (!parent || !isSceneLayerAnchorActor(parent)) return parentId;
    visited.add(parentId);
    parentId = parent.parentId;
  }
  return null;
}

/** Full rebuild of the editor scene; `EditorSceneSync` does incremental work. */
export function applySceneToBabylonScene(
  scene: Scene,
  sceneData: SerializedScene,
  assets?: MeshAssetContext,
): void {
  const layout = resolveOverlayLayout(sceneData.actors, { pixelsPerUnit: assets?.pixelsPerUnit, textureSize: guid => assets?.texturePixelSizes?.get(guid) });
  sceneData = { ...sceneData, actors: layout.actors };
  clearSceneMeshes(scene);

  const meshAssets: MeshAssetContext = {
    ...(assets ?? {}),
    modelSources: installModelSources(assets ?? {}),
    drawMeshCollision:
      assets?.drawMeshCollision ?? sceneData.settings.physicsWorld !== "2d",
  };

  const meshes = new Map<string, Mesh>();
  const loadBinding = {
    slotAnimEpoch: new Map<number, number>(),
    slotAnimationGroups: new Map(),
    slotAnimLoads: new Map<number, Promise<void>>(),
    modelBytes: meshAssets.modelBytes,
    modelSources: meshAssets.modelSources,
    modelPayloads: meshAssets.modelPayloads,
    modelClipAnimationGuids: meshAssets.modelClipAnimationGuids,
    retargetAnimationLoads: meshAssets.retargetAnimationLoads,
    textureBytes: meshAssets.textureBytes,
    materialTextureGuids: meshAssets.materialTextureGuids,
  };
  let loadSlot = 0;
  const actorIndex = new SceneActorIndex(sceneData.actors);
  for (const actor of sceneData.actors) {
    if (isSceneLayerAnchorActor(actor)) continue;
    const mesh = createActorMesh(scene, actor, meshAssets, actorIndex);
    applyActorTransform(mesh, actor);
    applyActorComponentSorting(mesh, actor, assets?.sortingLayers ?? ["Background", "Default", "Foreground", "UI"]);
    meshes.set(actor.id, mesh);
    for (const { component, guid } of modelMeshComponentsOf(actor)) {
      const bytes = meshAssets.modelSources?.get(guid);
      if (!bytes) continue;
      void beginSlotModelAnimLoad(
        scene,
        loadBinding,
        ++loadSlot,
        guid,
        bytes,
        editorModelLoadTarget(mesh, actor, component),
        () => {
          applyActorTransform(mesh, actor);
          applyAuthoredActorMaterialInstances(mesh, actor, meshAssets);
        },
      );
    }
  }

  const actorsById = new Map(sceneData.actors.map((actor) => [actor.id, actor]));
  for (const actor of sceneData.actors) {
    const parentId = editorActorParentId(actor, actorsById);
    if (!parentId) continue;
    const mesh = meshes.get(actor.id);
    const parent = meshes.get(parentId);
    if (mesh && parent) {
      mesh.parent = parent;
    }
  }

  syncEditorCablePreviews(scene, sceneData.actors, { gravity: sceneData.settings.gravity });
  applyEditorLayoutClips(scene, layout.entries);
  for (const mesh of meshes.values()) {
    freezeStaticActorWorldMatrix(mesh);
  }

  syncAuthoredIllumination(scene, sceneData, {
    stealActiveCamera: true,
    applyClearColor: true,
    assets,
  });
}

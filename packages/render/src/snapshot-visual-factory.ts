import { createWaterMesh } from "./water-mesh";
import { createWaterRemovalMesh } from "./water-removal-mesh";
import { createCableMesh } from "./cable-mesh";
import { createDynamicRuntimeMesh } from "./dynamic-runtime-mesh";
import { createMirrorSurfaceMesh } from "./mirrors";
import {
  Mesh,
  MeshBuilder,
  Quaternion,
  TransformNode,
  type Scene,
} from "@babylonjs/core";
import {
  DEFAULT_SORTING_LAYERS,
  emptySkyboxFaces,
  parseMirrorProperties,
  parseOverlayPanelProperties,
  type Text2DProperties,
  type Text3DProperties,
} from "@haptic/core";
import { parseColliderProperties, type ColliderShape } from "@haptic/physics";
import {
  applyAlbedoTexture,
  applyTilemapAlbedoTextures,
} from "./mesh-assets";
import {
  createOverlayTextureQuad,
  createOverlayUnlitMaterial,
} from "./overlay-texture-quad";
import { VisualBundle } from "./visual-bundle";
import { createOverlayPanelMesh } from "./overlay-panel-mesh";
import {
  beginSlotModelAnimLoad,
  createModelActorRoot,
} from "./glb-anim";
import {
  applySerializedTransform,
  createPrimitiveMesh,
} from "./scene-loader";
import { createColliderVisualMesh } from "./collider-visual";
import {
  applyComponentSorting,
  applyWorldVisualGroup,
} from "./sorting";
import { sceneShadowController } from "./shadow-controller";
import { createSpriteQuad } from "./sprite-quad";
import {
  createTilemapMeshes,
  worldTileSize,
} from "./tilemap-mesh";
import { createSkyboxMesh, resolveSkyboxCubeTexture } from "./skybox";
import { createText3DMesh } from "./text3d-mesh";
import { createText2DMesh, text2DBitmapBytes } from "./text2d-mesh";
import { createJoystick2DMesh } from "./joystick2d-mesh";
import { createUIControl2DMesh } from "./ui-controls2d-mesh";
import { createPainter2DMesh } from "./painter2d-mesh";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import { SPRING_ARM_MESH_KIND } from "./spring-arm";
import { createLandscapeMesh } from "./landscape-mesh";
import { createFoliageMesh } from "./foliage-mesh";
import {
  partsNeedOrigin,
  playComponentMeshName,
  type AssignMeshCommand,
  type AssignMeshPart,
  type DeferredModelLoad,
  type PlayVisualTargets,
  type SnapshotSceneBinding,
} from "./snapshot-binding";
import {
  appliedPlayVisibilityOf,
  setPlayVisualVisibility,
} from "./snapshot-visibility";
import { applyLoadedModelMaterials } from "./snapshot-materials";
import {
  applyPlayShadows,
  componentIlluminationOf,
  createPlayHelperMesh,
  setActorIllumination,
  type ComponentIllumination,
} from "./snapshot-illumination";
import { attachPlaySpringArms } from "./snapshot-spring-arms";
import {
  rememberPlayVisualAncestors,
  rememberPlayVisualComponents,
  restoreComponentPoses,
} from "./snapshot-component-commands";

function applyPartTransform(mesh: Mesh, part: AssignMeshPart): void {
  applySerializedTransform(mesh, {
    position: part.position,
    rotation: part.rotation,
    scale: part.scale,
  });
}

/** Replay primary/part sorting whenever a snapshot visual is reconstructed. */
export function applyPlayVisualSorting(root: Mesh, slotId: number, binding: SnapshotSceneBinding): void {
  const primary = binding.meshSorting.get(slotId);
  const parts = binding.meshParts.get(slotId);
  const shadows = sceneShadowController(root.getScene());
  if (partsNeedOrigin(parts)) {
    for (const part of parts ?? []) {
      const target = root.getChildMeshes().find((mesh) => mesh.name === playComponentMeshName(slotId, part.componentId));
      if (target) shadows.setParticipation(target, part);
    }
  } else if (parts?.[0]) shadows.setParticipation(root, parts[0]);
  const layers = binding.sortingLayers ?? DEFAULT_SORTING_LAYERS;
  const actorId = primary?.actorGuid ?? `actor-${slotId}`;
  if (partsNeedOrigin(parts)) {
    for (const part of parts ?? []) {
      if (part.meshKind !== "sprite" && part.meshKind !== "tilemap" && part.sortingLayer == null && part.orderInLayer == null) continue;
      const target = root.getChildMeshes().find((mesh) => mesh.name === playComponentMeshName(slotId, part.componentId));
      if (target) applyComponentSorting(target, layers, part.sortingLayer ?? "Default", part.orderInLayer ?? 0, `${actorId}|${part.componentId}`);
    }
    return;
  }
  const part = parts?.[0];
  const kind = binding.meshKinds.get(slotId);
  if (kind !== "sprite" && kind !== "tilemap" && primary?.sortingLayer == null && primary?.orderInLayer == null) return;
  applyComponentSorting(root, layers, part?.sortingLayer ?? primary?.sortingLayer ?? "Default",
    part?.orderInLayer ?? primary?.orderInLayer ?? 0,
    `${actorId}|${binding.primaryComponentIds.get(slotId) ?? part?.componentId ?? ""}`);
}

export function isPlayHelperMeshKind(
  meshKind: string | null | undefined,
): boolean {
  if (!meshKind) return true;
  return (
    meshKind === "camera" ||
    meshKind === "audio" ||
    meshKind === "particle" ||
    meshKind === "rigidbody" ||
    meshKind === SPRING_ARM_MESH_KIND ||
    meshKind === "renderTargetCapture" ||
    meshKind.startsWith("light:")
  );
}

/** Collider kinds only a 2D physics world accepts; every other kind parses as 3D. */
const PLAY_2D_COLLIDER_KINDS = new Set(["box2d", "circle", "capsule2d", "polygon", "chain"]);

function parsePlayColliderShape(encoded: string): ColliderShape {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (parsed && typeof parsed === "object" && "kind" in parsed) {
      // Authored rows (for example triangle-mesh vertices) normalize as in the editor visual.
      const world = PLAY_2D_COLLIDER_KINDS.has(String(parsed.kind)) ? "2d" : "3d";
      return parseColliderProperties({ shape: parsed }, world, { validation: "authoring" }).shape;
    }
  } catch {
    // Fall through to a unit box so Play still has a visible collider.
  }
  return { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
}

export function createPlayVisual(
  scene: Scene,
  slotId: number,
  binding: SnapshotSceneBinding,
  deferredModels?: DeferredModelLoad[],
  targets?: PlayVisualTargets,
): Mesh {
  const parts = binding.meshParts.get(slotId);
  const meshKind = binding.meshKinds.get(slotId);
  const assetGuid = binding.meshAssetGuids.get(slotId);
  if (!partsNeedOrigin(parts)) {
    const mesh = createPlayMesh(scene, slotId, meshKind, assetGuid, binding, undefined, undefined, undefined, deferredModels, undefined, targets);
    const componentId = binding.primaryComponentIds.get(slotId);
    if (componentId) {
      const style = binding.overlayStyles.get(slotId)?.get(componentId);
      if (style) applyOverlayVisualStyle(mesh, style);
      rememberPlayVisualComponents(mesh, new Map([[componentId, mesh]]));
    }
    restoreComponentPoses(binding, slotId, mesh);
    applyPlayVisualSorting(mesh, slotId, binding);
    return mesh;
  }
  const root = MeshBuilder.CreateSphere(
    `actor-${slotId}`,
    { diameter: 0.75 },
    scene,
  );
  root.isVisible = false;
  root.metadata = { ...(root.metadata ?? {}), playActorOrigin: true };
  const meshes = new Map<string, Mesh>();
  const chains = new Map<string, TransformNode[]>();
  rememberPlayVisualAncestors(root, chains);
  const illumination: ComponentIllumination[] = [];
  let retainedBitmapBytes = text2DBitmapBytes(binding.meshes.get(slotId));
  try {
    for (const part of parts ?? []) {
      const child = createPlayMesh(
        scene,
        slotId,
        part.meshKind,
        part.meshAssetGuid,
        binding,
        playComponentMeshName(slotId, part.componentId),
        part.text3d,
        part.text2d,
        deferredModels,
        retainedBitmapBytes,
        targets,
        part.landscape,
        part.foliage,
        part.water,
        part.waterRemoval,
        part.cable,
        part.dynamicMesh,
        part.painter,
        part,
      );
      child.parent = root;
      const style = binding.overlayStyles.get(slotId)?.get(part.componentId);
      if (style) applyOverlayVisualStyle(child, style);
      retainedBitmapBytes += text2DBitmapBytes(child);
      applyPartTransform(child, part);
      meshes.set(part.componentId, child);
      const helper = componentIlluminationOf(child);
      if (helper) illumination.push(helper);
    }
    for (const part of parts ?? []) {
      const child = meshes.get(part.componentId);
      if (!child) continue;
      // The link that would close a component parent cycle attaches to the origin.
      const named = part.parentId ? meshes.get(part.parentId) : undefined;
      const parent = named && named !== child && !named.isDescendantOf(child) ? named : undefined;
      child.parent = parent ?? root;
      let attachment: TransformNode = child;
      const ancestors: TransformNode[] = [];
      chains.set(part.componentId, ancestors);
      for (const transform of part.parentTransforms ?? []) {
        const ancestor = new TransformNode(`${child.name}-attachment`, scene);
        ancestors.push(ancestor);
        ancestor.position.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
        ancestor.rotationQuaternion = new Quaternion(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
        ancestor.scaling.copyFromFloats(transform.scale.x, transform.scale.y, transform.scale.z);
        ancestor.parent = parent ?? root;
        attachment.parent = ancestor;
        attachment = ancestor;
      }
    }
    attachPlaySpringArms(binding, root, slotId, parts ?? [], meshes);
    if (illumination.length) setActorIllumination(root, illumination);
    if (!targets && illumination.some(helper => helper.light)) applyPlayShadows(scene);
    rememberPlayVisualComponents(root, meshes);
    restoreComponentPoses(binding, slotId, root);
    applyPlayVisualSorting(root, slotId, binding);
    return root;
  } catch (error) {
    root.dispose();
    throw error;
  }
}

export function createPlayMesh(
  scene: Scene,
  slotId: number,
  meshKind: string | null | undefined,
  assetGuid?: string | null,
  binding?: SnapshotSceneBinding,
  meshName?: string,
  partText3d?: Text3DProperties,
  partText2d?: Text2DProperties | AssignMeshCommand["text2d"],
  deferredModels?: DeferredModelLoad[],
  retainedBitmapBytes?: number,
  targets?: PlayVisualTargets,
  landscape?: import("@haptic/core").LandscapeProperties,
  foliage?: import("@haptic/core").FoliageProperties,
  water?: import("@haptic/core").WaterBodyProperties,
  waterRemoval?: import("@haptic/core").WaterRemovalProperties,
  cable?: import("@haptic/core").CableProperties & { simulationId?: number },
  dynamicMesh?: { meshId: number; update: import("@haptic/core").DynamicMeshUpdate },
  painter?: import("@haptic/core").Painter2DProperties,
  illuminationPart?: AssignMeshPart,
): Mesh {
  const name = meshName ?? `actor-${slotId}`;
  if (meshKind === "dynamicRuntimeMesh") return finishPlayWorldMesh(createDynamicRuntimeMesh(scene, name, dynamicMesh));
  if (meshKind === "2dlayout") {
    const mesh = new Mesh(name, scene);
    mesh.isPickable = false;
    return mesh;
  }
  if (meshKind === "2dcontrol" && illuminationPart?.uiControl) return createUIControl2DMesh(scene, name, illuminationPart.uiControl, binding, illuminationPart.componentId);
  if (meshKind === "2djoystick") return createJoystick2DMesh(scene, name, illuminationPart?.joystick, binding);
  if (meshKind === "2dpainter") {
    const properties = painter ?? binding?.meshParts.get(slotId)?.find((part) => part.meshKind === "2dpainter" && (!meshName || playComponentMeshName(slotId, part.componentId) === meshName))?.painter;
    return createPainter2DMesh(scene, name, properties);
  }
  if (meshKind === "cable" && cable) {
    const mesh = createCableMesh(scene, name, cable, cable.simulationId, (id) => binding?.meshes.get(id));
    if (cable.materialGuid) mesh.material = binding?.resolveMaterial?.(cable.materialGuid, { scene }) ?? null;
    return finishPlayWorldMesh(mesh);
  }
  if (meshKind === "mirror") return finishPlayWorldMesh(createMirrorSurfaceMesh(scene, name, parseMirrorProperties(illuminationPart?.mirror)));
  if (meshKind === "waterRemoval" && waterRemoval) return createWaterRemovalMesh(scene, name, waterRemoval, { editor: false });
  if (meshKind === "water" && water) {
    const definition = assetGuid ? binding?.waters?.get(assetGuid) : undefined;
    const material = definition?.materialGuid ? binding?.resolveMaterial?.(definition.materialGuid) : null;
    return finishPlayWorldMesh(createWaterMesh(scene, name, water, definition, material));
  }
  if (meshKind === "landscape" && landscape) return createLandscapeMesh(scene, name, landscape, binding);
  if (meshKind === "foliage" && foliage) return createFoliageMesh(scene, name, foliage, binding);
  if (meshKind === "tilemap" && assetGuid && binding?.tilemaps) {
    const tilemap = binding.tilemaps.get(assetGuid);
    const tilesets = binding.tilesets ?? new Map();
    if (tilemap && tilesets.size > 0) {
      const size = worldTileSize(tilemap, binding.pixelsPerUnit ?? 100);
      const mesh = createTilemapMeshes(
        scene,
        name,
        tilemap,
        tilesets,
        size.width,
        size.height,
      );
      applyTilemapAlbedoTextures(mesh, scene, binding);
      return mesh;
    }
  }
  if (meshKind === "sprite") {
    const payload = assetGuid
      ? binding?.spritePayloads?.get(assetGuid)
      : undefined;
    const frame = payload?.frames[0];
    const mesh = frame
      ? createSpriteQuad(
          scene,
          name,
          frame,
          payload?.pixelsPerUnit ?? binding?.pixelsPerUnit,
        )
      : createPrimitiveMesh(scene, name, "sprite");
    applyAlbedoTexture(mesh, scene, payload?.textureGuid, binding);
    // Sprite clip crossfades blend the slot's own visual (`resolvePlaySpriteSlot`);
    // a component part's quad must not take over that single tracked overlay.
    if (frame && binding && meshName === undefined) {
      if (!binding.spriteOverlays) binding.spriteOverlays = new Map();
      const overlay = createSpriteQuad(
        scene,
        `${name}-blend`,
        frame,
        payload?.pixelsPerUnit ?? binding.pixelsPerUnit,
      );
      overlay.parent = mesh;
      overlay.visibility = 0;
      applyAlbedoTexture(overlay, scene, payload?.textureGuid, binding);
      (targets?.spriteOverlays ?? binding.spriteOverlays).set(slotId, overlay);
    }
    return mesh;
  }
  if (meshKind === "2dpanel") {
    const props =
      binding?.overlayPanelProps.get(slotId) ??
      parseOverlayPanelProperties({
        source: "texture",
        textureGuid: assetGuid,
      });
    const mesh = createOverlayPanelMesh(scene, name, props, binding);
    mesh.isPickable = false;
    return mesh;
  }
  if (
    meshKind === "2dtexture" ||
    meshKind === "2dmaterial" ||
    meshKind === "2dbutton"
  ) {
    if (meshKind === "2dtexture") {
      const mesh = createOverlayTextureQuad(scene, name, assetGuid, binding);
      mesh.isPickable = false;
      return mesh;
    }
    const mesh = MeshBuilder.CreatePlane(name, { width: 1, height: 1 }, scene);
    const bundle = new VisualBundle();
    mesh.onDisposeObservable.addOnce(() => bundle.dispose());
    mesh.material = createOverlayUnlitMaterial(scene, name, bundle);
    mesh.isPickable = meshKind === "2dbutton";
    if (meshKind === "2dmaterial" && assetGuid && binding?.resolveMaterial) {
      const compiled = binding.resolveMaterial(assetGuid, {
        scene,
        unlit: true,
      });
      if (compiled) mesh.material = compiled;
    }
    return mesh;
  }
  // Text kinds carry their Font as the asset guid, so they precede the Model branch.
  if (meshKind === "text3d") {
    const fromPart =
      partText3d ??
      binding?.meshParts
        .get(slotId)
        ?.find(
          (part) => playComponentMeshName(slotId, part.componentId) === name,
        )?.text3d;
    const props = fromPart ?? binding?.text3dProps.get(slotId);
    return finishPlayWorldMesh(
      createText3DMesh(scene, name, props ?? {}, binding),
    );
  }
  if (meshKind === "2dtext" || meshKind === "2drichtext") {
    const fromPart =
      partText2d ??
      binding?.meshParts
        .get(slotId)
        ?.find(
          (part) => playComponentMeshName(slotId, part.componentId) === name,
        )?.text2d;
    const props = fromPart ?? binding?.text2dProps.get(slotId);
    return createText2DMesh(scene, name, props ?? {}, binding, {
      rich: meshKind === "2drichtext",
      isPaused: () => binding?.paused === true,
      bitmapLimits: { retainedBytes: retainedBitmapBytes ?? text2DBitmapBytes(binding?.meshes.get(slotId)) },
    });
  }
  if (assetGuid) {
    const root = createModelActorRoot(scene, name);
    const bytes = binding?.modelSources?.get(assetGuid);
    const start: DeferredModelLoad = async (preparation) => {
      if (!bytes || !binding) {
        if (preparation) throw new Error(`Model ${assetGuid} source is not installed.`);
        return;
      }
      // Parts own independent native instances and preparation epochs. Only the
      // winning whole hierarchy publishes their animation lookup into the slot.
      const owner = preparation ? {
        ...binding, slotAnimEpoch: new Map(), slotAnimLoads: new Map(), slotAnimationGroups: new Map(),
        pendingAnimState: undefined, slotAnimReady: undefined,
      } : binding;
      await beginSlotModelAnimLoad(
        scene, owner, slotId, assetGuid, bytes, root,
        preparation ? undefined : () => {
          // Late glTF parts join an applied slot; unchanged samples are not
          // re-applied (for example while paused), so hide or show them now.
          const slotRoot = binding.meshes.get(slotId);
          const visible = slotRoot ? appliedPlayVisibilityOf(slotRoot) : undefined;
          if (slotRoot && visible !== undefined) setPlayVisualVisibility(binding, slotRoot, visible, true);
          binding.onVisualChanged?.(slotId);
        },
        preparation?.ownsLoad,
        (prepared) => applyLoadedModelMaterials(binding, slotId, assetGuid, prepared),
      );
    };
    if (deferredModels) deferredModels.push(start);
    else void start().catch(() => {});
    return finishPlayWorldMesh(root);
  }
  if (meshKind === "skybox") {
    const props = binding?.skyboxProps.get(slotId);
    const texture = resolveSkyboxCubeTexture(
      scene,
      props?.faces ?? emptySkyboxFaces(),
      binding,
    );
    return createSkyboxMesh(scene, name, texture, props?.size ?? 1000);
  }
  if (meshKind?.startsWith("collider:")) {
    return finishPlayWorldMesh(
      createColliderVisualMesh(
        scene,
        name,
        parsePlayColliderShape(meshKind.slice("collider:".length)),
      ),
    );
  }
  if (isPlayHelperMeshKind(meshKind)) {
    return finishPlayWorldMesh(createPlayHelperMesh(scene, slotId, name, meshKind, binding, targets, illuminationPart));
  }
  return finishPlayWorldMesh(createPrimitiveMesh(scene, name, meshKind));
}

function finishPlayWorldMesh(mesh: Mesh): Mesh {
  applyWorldVisualGroup(mesh, { components: [] });
  return mesh;
}

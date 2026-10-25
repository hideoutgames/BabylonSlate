import type {
  AbstractMesh,
  Camera,
  Mesh,
  Scene,
} from "@babylonjs/core";
import {
  emptySkyboxFaces,
  parseOverlayPanelProperties,
  parseText2DProperties,
  parseText3DProperties,
  parseOverlayVisualStyle,
  type OverlayVisualStyle,
} from "@haptic/core";
import {
  ownedVisualTexturePreparation,
  meshAssetFingerprint,
  meshAssetInstallRevision,
  type MeshAssetContext,
} from "./mesh-assets";
import {
  beginSlotModelAnimLoad,
  createModelActorRoot,
  isEditorModelPlaceholder,
  isSlotModelInstalled,
  invalidateSlotAnimLoad,
  publishModelHierarchyAnimations,
} from "./glb-anim";
import {
  applyAuthoredCameraProperties,
  applyAuthoredLightProperties,
} from "./scene-illumination";
import { joystick2DMesh } from "./joystick2d-mesh";
import { uiControl2DMesh } from "./ui-controls2d-mesh";
import { BitmapAllocationLimitError } from "./text2d-bitmap";
import { SPRING_ARM_MESH_KIND } from "./spring-arm";
import {
  partsNeedOrigin,
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
import {
  applyLoadedModelMaterials,
  applyMaterialToActorMeshes,
  hasRetainedMaterialOwners,
  materialPreparationRestarts,
  releaseRetainedMaterialOwners,
  retainWorkingMaterialOwners,
  retireRemovedComponentMaterials,
} from "./snapshot-materials";
import {
  actorIlluminationOf,
  applyPlayShadows,
  hasActorIllumination,
  refreshPlayActiveCamera,
  updateComponentIllumination,
} from "./snapshot-illumination";
import {
  cancelPendingVisualReplacement,
  hasPendingVisualReplacement,
  pendingVisualReplacement,
  pendingVisualReplacementsOf,
  recordVisualAssignment,
  visualAssignmentOf,
} from "./snapshot-component-commands";
import {
  applyPlayVisualSorting,
  createPlayVisual,
} from "./snapshot-visual-factory";
import { noteReplacesDrawnVisual, visualHasShown } from "./reveal-pending";

const rejectedTextAssignments = new WeakMap<SnapshotSceneBinding, Map<number, string>>();
const rejectedPreparedAssignments = new WeakMap<SnapshotSceneBinding, Map<number, string>>();

export function forgetRejectedAssignments(binding: SnapshotSceneBinding, slotId: number): void {
  rejectedTextAssignments.get(binding)?.delete(slotId);
  rejectedPreparedAssignments.get(binding)?.delete(slotId);
}

export function disposeRejectedAssignments(binding: SnapshotSceneBinding): void {
  rejectedPreparedAssignments.delete(binding);
  rejectedTextAssignments.delete(binding);
}

/**
 * What each assignment built: the install revision of the assets it read (`meshAssetInstallRevision`, which holds no
 * asset map), the visual it built or is preparing, held weakly (an assignment the slot keeps must not keep a visual
 * since disposed), and whether building it failed (its staged construction threw, or its model load failed).
 */
type BuiltVisual = { revision: number; visual: WeakRef<Mesh> | undefined; failed: boolean };
const builtVisuals = new WeakMap<AssignMeshCommand, BuiltVisual>();
/** Assignments whose staged visual's construction threw: nothing was built for them. */
const failedConstructions = new WeakSet<AssignMeshCommand>();

/** Hash a request and its installed assets only to compare or record a rejection. */
function rejectionKey(command: AssignMeshCommand, assets: MeshAssetContext, suffix = ""): () => string {
  let key: string | undefined;
  return () => key ??= `${JSON.stringify(command)}|${meshAssetFingerprint(assets)}${suffix}`;
}

const overlayVisualKinds = new Set(["2dtexture", "2dmaterial", "2dpanel", "2dtext", "2drichtext", "2dpainter", "2djoystick", "2dcontrol"]);

/** One assignMesh request, recorded on the binding, as each strategy below reads it. */
interface AssignMeshContext {
  readonly scene: Scene;
  readonly binding: SnapshotSceneBinding;
  readonly command: AssignMeshCommand;
  readonly meshKind: string | null;
  readonly previousParts: NonNullable<AssignMeshCommand["parts"]> | undefined;
  readonly reusable: boolean;
  readonly componentHelpers: boolean | undefined;
  readonly retireRemovedMaterials: () => void;
}

/**
 * Remember (and rebuild) the Play mesh for a slot from an assignMesh command. The runtime re-sends an actor's visual
 * with every component property write, unchanged when the value was (a script writing a Text3D's text every tick), so
 * a command asking for the visual the slot already shows, or is preparing, in `scene` keeps it (`showsAssignment`): a
 * rebuild would replace a drawn mesh with one that has not drawn, which a world view hides until its variants, and on
 * WebGPU its pipelines, are known ready, and would restart a staged visual's preparation before it ever adopts.
 */
export function applyAssignMesh(
  scene: Scene,
  binding: SnapshotSceneBinding,
  command: AssignMeshCommand,
): void {
  if (showsAssignment(scene, binding, command)) return;
  assignVisual(scene, binding, command);
}

/**
 * Whether `command` is the assignment the slot's visual in `scene` was built for, and that visual is still the one the
 * slot shows or is preparing: equal, as later commands left that assignment (style, control state, painter and text
 * reveal commands update it and the visual in place), built with the installed assets the binding holds now, and its
 * model load not failed. Anything else rebuilds: a retired slot, a visual moved to another host Scene or rebuilt from
 * the slot's state, a preparation or model load that failed (the same assignment tries again).
 */
function showsAssignment(scene: Scene, binding: SnapshotSceneBinding, command: AssignMeshCommand): boolean {
  const current = visualAssignmentOf(binding, command.slotId);
  const built = current && builtVisuals.get(current);
  const visual = built?.visual?.deref();
  if (!current || !built || !visual || built.failed || built.revision !== meshAssetInstallRevision(binding)) return false;
  const shown = pendingVisualReplacement(binding, command.slotId) ?? binding.meshes.get(command.slotId);
  if (shown !== visual || shown.isDisposed() || shown.getScene() !== scene) return false;
  return current === command || JSON.stringify(current) === JSON.stringify(command);
}

/** Builds the slot's visual for `command`, then records what it built (`builtVisuals`). */
function assignVisual(scene: Scene, binding: SnapshotSceneBinding, command: AssignMeshCommand): void {
  // A material command's restart builds the same assignment again.
  failedConstructions.delete(command);
  assignMeshVisual(scene, binding, command);
  const visual = pendingVisualReplacement(binding, command.slotId) ?? binding.meshes.get(command.slotId);
  const built: BuiltVisual = {
    revision: meshAssetInstallRevision(binding), failed: failedConstructions.has(command), visual: visual && new WeakRef(visual),
  };
  builtVisuals.set(command, built);
  // Observed without turning the slot's load into a success: a readiness wait on it must still reject.
  void binding.slotAnimLoads?.get(command.slotId)?.catch(() => { built.failed = true; });
}

function assignMeshVisual(
  scene: Scene,
  binding: SnapshotSceneBinding,
  command: AssignMeshCommand,
): void {
  const assign = beginAssignMesh(scene, binding, command);
  if (reuseIlluminationHelpers(assign)) return;
  if (updateLightInPlace(assign)) return;
  if (updateCameraInPlace(assign)) return;
  const existing = binding.meshes.get(command.slotId);
  const modelSource = command.meshAssetGuid ? binding.modelSources?.get(command.meshAssetGuid) : undefined;
  if (loadIntoModelPlaceholder(assign, existing, modelSource)) return;
  if (stagePreparedVisual(assign, existing, modelSource)) return;
  rebuildVisual(assign, existing);
}

/** Record the request's kind, parts and properties; every strategy starts from them. */
function beginAssignMesh(
  scene: Scene,
  binding: SnapshotSceneBinding,
  command: AssignMeshCommand,
): AssignMeshContext {
  recordVisualAssignment(binding, command);
  const previousParts = binding.meshParts.get(command.slotId);
  const reusable = !hasPendingVisualReplacement(binding, command.slotId) &&
    binding.meshKinds.get(command.slotId) === (command.meshKind ?? null) &&
    binding.meshAssetGuids.get(command.slotId) === command.meshAssetGuid;
  cancelPendingVisualReplacement(binding, command.slotId);
  const primaryId = !partsNeedOrigin(command.parts)
    ? (command.primaryComponentId ?? command.parts?.[0]?.componentId)
    : undefined;
  if (primaryId) binding.primaryComponentIds.set(command.slotId, primaryId);
  else binding.primaryComponentIds.delete(command.slotId);
  const styles = new Map<string, OverlayVisualStyle>();
  for (const part of command.parts ?? []) if (overlayVisualKinds.has(part.meshKind ?? "")) styles.set(part.componentId, parseOverlayVisualStyle(part.overlayStyle));
  if (primaryId && overlayVisualKinds.has(command.meshKind ?? "") && !styles.has(primaryId)) styles.set(primaryId, parseOverlayVisualStyle(command.overlayStyle));
  binding.overlayStyles.set(command.slotId, styles);
  const componentIds = command.parts?.length
    ? new Set(command.parts.map((part) => part.componentId))
    : primaryId
      ? new Set([primaryId])
      : null;
  const retireRemovedMaterials = () => retireRemovedComponentMaterials(binding, command.slotId, componentIds);
  const meshKind = command.meshKind ?? null;
  binding.meshKinds.set(command.slotId, meshKind);
  binding.meshSorting.set(command.slotId, { actorGuid: command.actorGuid, sortingLayer: command.sortingLayer, orderInLayer: command.orderInLayer });
  binding.meshAssetGuids.set(command.slotId, command.meshAssetGuid);
  if (command.parts && command.parts.length > 0) {
    binding.meshParts.set(command.slotId, command.parts);
  } else {
    binding.meshParts.delete(command.slotId);
  }
  if (command.skybox) {
    binding.skyboxProps.set(command.slotId, command.skybox);
  } else if (meshKind === "skybox") {
    binding.skyboxProps.set(command.slotId, {
      size: 1000,
      faces: emptySkyboxFaces(),
    });
  }
  if (command.light) binding.lightProps.set(command.slotId, command.light);
  if (command.text3d) {
    binding.text3dProps.set(command.slotId, command.text3d);
  } else if (meshKind === "text3d") {
    binding.text3dProps.set(command.slotId, parseText3DProperties({}));
  }
  if (command.text2d) {
    binding.text2dProps.set(
      command.slotId,
      parseText2DProperties(command.text2d, {
        rich: meshKind === "2drichtext",
      }),
    );
  } else if (meshKind === "2dtext" || meshKind === "2drichtext") {
    binding.text2dProps.set(
      command.slotId,
      parseText2DProperties({}, { rich: meshKind === "2drichtext" }),
    );
  }
  if (command.overlayPanel) {
    binding.overlayPanelProps.set(command.slotId, {
      ...parseOverlayPanelProperties(command.overlayPanel),
      destWidth: command.overlayPanel.destWidth,
      destHeight: command.overlayPanel.destHeight,
    });
  } else if (meshKind === "2dpanel") {
    binding.overlayPanelProps.set(
      command.slotId,
      parseOverlayPanelProperties({
        source: "texture",
        textureGuid: command.meshAssetGuid,
      }),
    );
  }
  if (command.camera) {
    binding.cameraProps.set(command.slotId, command.camera);
    if (command.camera.isDefault) {
      binding.defaultCameraSlotId = command.slotId;
    } else if (binding.defaultCameraSlotId === command.slotId) {
      binding.defaultCameraSlotId = null;
    }
  }
  const componentHelpers = command.parts?.some(part => part.light || part.camera);
  return { scene, binding, command, meshKind, previousParts, reusable, componentHelpers, retireRemovedMaterials };
}

/** Light and camera property changes update a multipart actor's existing helpers. */
function reuseIlluminationHelpers(assign: AssignMeshContext): boolean {
  const { scene, binding, command, previousParts, reusable, componentHelpers } = assign;
  const existingRoot = binding.meshes.get(command.slotId);
  if (componentHelpers && reusable && existingRoot?.getScene() === scene && previousParts && command.parts &&
    hasActorIllumination(existingRoot) && sameComponentVisuals(previousParts, command.parts)) {
    const parts = new Map(command.parts.map(part => [part.componentId, part]));
    let selectedCamera: Camera | undefined;
    for (const helper of actorIlluminationOf(existingRoot)!) {
      const part = helper.componentId ? parts.get(helper.componentId) : undefined;
      if (helper.light && part?.light) {
        helper.lightProperties = part.light;
        applyAuthoredLightProperties(helper.light, part.light);
      }
      if (helper.camera && part?.camera) {
        applyAuthoredCameraProperties(helper.camera, part.camera);
        if (!selectedCamera || part.camera.isDefault) selectedCamera = helper.camera;
      }
    }
    if (selectedCamera) binding.cameras.set(command.slotId, selectedCamera);
    stampOverlayPick(existingRoot, command);
    applyPlayVisualSorting(existingRoot, command.slotId, binding);
    applyPlayShadows(scene);
    refreshPlayActiveCamera(scene, binding);
    return true;
  }
  return false;
}

/** A light actor's property change updates its light. */
function updateLightInPlace(assign: AssignMeshContext): boolean {
  const { scene, binding, command, componentHelpers } = assign;
  const existingLight = binding.lights.get(command.slotId);
  if (existingLight && command.light && !componentHelpers) {
    applyAuthoredLightProperties(existingLight, command.light);
    applyPlayShadows(scene);
    refreshPlayActiveCamera(scene, binding);
    return true;
  }
  return false;
}

/** A camera actor's property change updates its camera. */
function updateCameraInPlace(assign: AssignMeshContext): boolean {
  const { scene, binding, command, componentHelpers } = assign;
  const existingCamera = binding.cameras.get(command.slotId);
  const hasSpringArm = command.parts?.some((part) => part.meshKind === SPRING_ARM_MESH_KIND);
  if (existingCamera && command.camera && !hasSpringArm && !componentHelpers) {
    applyAuthoredCameraProperties(existingCamera, command.camera);
    refreshPlayActiveCamera(scene, binding);
    return true;
  }
  return false;
}

/** An editor model placeholder loads the model into itself. */
function loadIntoModelPlaceholder(
  assign: AssignMeshContext,
  existing: Mesh | undefined,
  modelSource: Blob | undefined,
): boolean {
  const { scene, binding, command, retireRemovedMaterials } = assign;
  if (existing && existing.getScene() === scene && isEditorModelPlaceholder(existing) &&
    modelSource && command.meshAssetGuid && !partsNeedOrigin(command.parts)) {
    const guid = command.meshAssetGuid;
    if (isSlotModelInstalled(binding, guid, modelSource, existing)) {
      // Nothing loads, so register no preparation: same-tick material commands apply directly.
      stampOverlayPick(existing, command);
      applyPlayVisualSorting(existing, command.slotId, binding);
      if (hasRetainedMaterialOwners(binding, command.slotId)) {
        // A superseded replacement deferred material commands for this instance.
        applyMaterialToActorMeshes(binding, command.slotId, existing);
        retireRemovedMaterials();
        releaseRetainedMaterialOwners(binding, command.slotId);
        binding.onVisualChanged?.(command.slotId);
      }
      return true;
    }
    const refreshes = materialPreparationRestarts(binding);
    // A material command restarts the preparation for the same assignment: it rebuilds, whatever the slot shows.
    const restart = () => assignVisual(scene, binding, command);
    retainWorkingMaterialOwners(binding, command.slotId, Boolean(existing));
    refreshes.set(command.slotId, restart);
    const load = beginSlotModelAnimLoad(scene, binding, command.slotId, guid, modelSource, existing,
      () => {
        stampOverlayPick(existing, command);
        applyPlayVisualSorting(existing, command.slotId, binding);
        // Adopted glTF parts inherit the last snapshot flag, not live membership.
        setPlayVisualVisibility(binding, existing,
          appliedPlayVisibilityOf(existing) ?? binding.liveSlots.has(command.slotId), true);
        retireRemovedMaterials();
        releaseRetainedMaterialOwners(binding, command.slotId);
        binding.onVisualChanged?.(command.slotId);
      },
      () => binding.meshes.get(command.slotId) === existing && refreshes.get(command.slotId) === restart,
      (prepared) => applyLoadedModelMaterials(binding, command.slotId, guid, prepared),
    );
    void load.finally(() => {
      if (refreshes.get(command.slotId) === restart) refreshes.delete(command.slotId);
    }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Models and texture-owning visuals prepare a hidden successor and adopt it
 * once its loads finish, while the predecessor keeps drawing.
 */
function stagePreparedVisual(
  assign: AssignMeshContext,
  existing: Mesh | undefined,
  modelSource: Blob | undefined,
): boolean {
  const { scene, binding, command, meshKind, retireRemovedMaterials } = assign;
  const ownsTexture = (kind: string | null | undefined) =>
    kind === "skybox" || kind === "sprite" || kind === "tilemap";
  const stagesModels = Boolean(command.parts?.some((part) => part.foliage)) || Boolean(existing && modelSource && command.meshAssetGuid && !partsNeedOrigin(command.parts)) ||
    (partsNeedOrigin(command.parts) && command.parts?.some((part) =>
      part.meshAssetGuid && !["water", "sprite", "tilemap", "2djoystick", "2dcontrol", "2dpanel", "2dtexture", "2dmaterial", "2dbutton", "2dtext", "2drichtext"].includes(part.meshKind ?? "")));
  if (stagesModels || (existing && (ownsTexture(meshKind) || command.parts?.some((part) => ownsTexture(part.meshKind))))) {
    const working = existing ?? createModelActorRoot(scene, `actor-${command.slotId}`);
    if (!existing) binding.meshes.set(command.slotId, working);
    // Staged models never record or compare rejections. Other preparations keep
    // the request-time asset state: installs replace the binding's asset maps,
    // so a shallow copy is enough to key a later asynchronous rejection.
    const descriptor = rejectionKey(command, stagesModels ? binding : { ...binding });
    const rejected = rejectedPreparedAssignments.get(binding) ?? new Map<number, string>();
    rejectedPreparedAssignments.set(binding, rejected);
    if (!stagesModels && rejected.has(command.slotId) && rejected.get(command.slotId) === descriptor()) return true;
    const targets: PlayVisualTargets = { spriteOverlays: new Map(), lights: new Map(), cameras: new Map() };
    const deferred: DeferredModelLoad[] = [];
    let candidate: Mesh | undefined;
    let adopted = false;
    const releaseProvisional = () => {
      if (adopted) return;
      for (const light of targets.lights.values()) light.dispose();
      for (const camera of targets.cameras.values()) camera.dispose();
      targets.lights.clear(); targets.cameras.clear();
    };
    try {
      candidate = createPlayVisual(scene, command.slotId, binding, deferred, targets);
      candidate.setEnabled(false);
      candidate.onDisposeObservable.addOnce(releaseProvisional);
      stampOverlayPick(candidate, command);
      applyMaterialToActorMeshes(binding, command.slotId, candidate);
    } catch (error) {
      candidate?.dispose(); releaseProvisional();
      if (!stagesModels) rejected.set(command.slotId, descriptor());
      // Nothing was staged: the same assignment builds again (a rejected one returns above until its assets change).
      failedConstructions.add(command);
      console.warn(`[render] Visual preparation failed: ${String(error)}`);
      return true;
    }
    const staged = candidate;
    const pending = pendingVisualReplacementsOf(binding);
    pending.set(command.slotId, staged);
    const refreshes = materialPreparationRestarts(binding);
    const restart = () => assignVisual(scene, binding, command);
    retainWorkingMaterialOwners(binding, command.slotId, Boolean(existing));
    refreshes.set(command.slotId, restart);
    const ownsLoad = () => pending.get(command.slotId) === staged &&
      binding.meshes.get(command.slotId) === working && !staged.isDisposed() && !scene.isDisposed;
    const preparation = Promise.all([
      ownedVisualTexturePreparation(staged),
      ...deferred.map((start) => start({ ownsLoad })),
    ]);
    const load = preparation.then(() => {
      if (!ownsLoad()) return;
      staged.position.copyFrom(working.position);
      staged.rotation.copyFrom(working.rotation);
      staged.rotationQuaternion = working.rotationQuaternion?.clone() ?? null;
      staged.scaling.copyFrom(working.scaling);
      staged.parent = working.parent;
      // Material commands restart preparation; do not attach an unprepared
      // successor generation after the joined preparation has completed.
      // Retirement must not cancel this winning candidate or its new helpers.
      binding.slotVisualReady?.(command.slotId, staged);
      pending.delete(command.slotId);
      // The staged visual takes the place of the one the slot shows only now, as in a plain rebuild.
      const replacesShown = working.getScene() === scene && visualHasShown(working);
      disposeSlotVisuals(binding, command.slotId);
      retireRemovedMaterials();
      releaseRetainedMaterialOwners(binding, command.slotId);
      binding.meshes.set(command.slotId, staged);
      if (replacesShown) noteReplacesDrawnVisual(staged);
      for (const [slot, overlay] of targets.spriteOverlays) (binding.spriteOverlays ??= new Map()).set(slot, overlay);
      for (const [slot, light] of targets.lights) {
        binding.lights.set(slot, light);
        const props = binding.lightProps.get(slot);
        if (props) applyAuthoredLightProperties(light, props); else light.setEnabled(true);
      }
      for (const [slot, camera] of targets.cameras) binding.cameras.set(slot, camera);
      for (const helper of actorIlluminationOf(staged) ?? []) {
        if (helper.light) {
          if (helper.lightProperties) applyAuthoredLightProperties(helper.light, helper.lightProperties);
          else helper.light.setEnabled(true);
        }
      }
      adopted = true;
      rejected.delete(command.slotId);
      staged.setEnabled(true);
      updateComponentIllumination(staged);
      // The adopted root inherits the last snapshot flag, not live membership.
      setPlayVisualVisibility(binding, staged,
        appliedPlayVisibilityOf(working) ?? binding.liveSlots.has(command.slotId));
      if (deferred.length) publishModelHierarchyAnimations(binding, command.slotId, staged);
      refreshPlayActiveCamera(scene, binding);
      applyPlayShadows(scene);
      binding.onVisualChanged?.(command.slotId);
    }, (error: unknown) => {
      if (!ownsLoad()) return;
      if (stagesModels) throw error;
      rejected.set(command.slotId, descriptor());
      // The exact texture owner reports preparation failure once.
    }).finally(() => {
      if (refreshes.get(command.slotId) === restart) refreshes.delete(command.slotId);
      if (pending.get(command.slotId) === staged) pending.delete(command.slotId);
      if (!adopted) staged.dispose();
    }).then(() => {
      // Retiring the predecessor clears its slot load. Keep successful model
      // readiness observable without retaining the preparation's closures.
      // A newer assignment or retirement must remain authoritative.
      if (stagesModels && adopted && binding.meshes.get(command.slotId) === staged &&
        !binding.slotAnimLoads?.has(command.slotId)) {
        (binding.slotAnimLoads ??= new Map()).set(command.slotId, Promise.resolve());
      }
    });
    if (stagesModels) (binding.slotAnimLoads ??= new Map()).set(command.slotId, load);
    void load.catch((error: unknown) => console.warn(`[render] Visual publication failed: ${String(error)}`));
    return true;
  }
  return false;
}

/** Every other visual, text included, is rebuilt in place. */
function rebuildVisual(assign: AssignMeshContext, existing: Mesh | undefined): void {
  const { scene, binding, command, meshKind, retireRemovedMaterials } = assign;
  const stagesText = meshKind === "2dtext" || meshKind === "2drichtext" ||
    command.parts?.some((part) => part.meshKind === "2dtext" || part.meshKind === "2drichtext");
  // Text performs all allocation checks and construction while its predecessor
  // remains usable. Native retirement must not erase the newly authored props.
  let stagedText: Mesh | null = null;
  const deferredModels: DeferredModelLoad[] = [];
  if (stagesText) {
    // Script text writes re-emit assignMesh every tick; hash installed assets
    // only to compare or record a rejected allocation.
    const descriptor = rejectionKey(command, binding, `|${scene.getEngine().getCaps().maxTextureSize}`);
    const rejected = rejectedTextAssignments.get(binding);
    if (existing && rejected?.has(command.slotId) && rejected.get(command.slotId) === descriptor()) return;
    try {
      stagedText = createPlayVisual(scene, command.slotId, binding, deferredModels);
      rejected?.delete(command.slotId);
    } catch (error) {
      if (!(error instanceof BitmapAllocationLimitError) || !existing) throw error;
      const failed = rejected ?? new Map<number, string>();
      failed.set(command.slotId, descriptor());
      rejectedTextAssignments.set(binding, failed);
      console.warn(`[render] ${error.code}: ${error.message}`);
      return;
    }
  }
  if (stagedText) {
    stampOverlayPick(stagedText, command);
    try { applyMaterialToActorMeshes(binding, command.slotId, stagedText); }
    catch (error) { stagedText.dispose(); throw error; }
  }
  // A hidden text rewritten every tick must not show its new glyphs for a frame.
  const lastVisible = existing ? appliedPlayVisibilityOf(existing) : undefined;
  // Asked before the predecessor goes: a rebuild of a visual the view has shown is revealed without waiting for the
  // drawn shadow maps to list it (`noteReplacesDrawnVisual`).
  const replacesShown = existing?.getScene() === scene && visualHasShown(existing);
  if (existing) {
    disposeSlotVisuals(binding, command.slotId);
  }
  retireRemovedMaterials();
  releaseRetainedMaterialOwners(binding, command.slotId);
  const rebuilt = stagedText ?? createPlayVisual(scene, command.slotId, binding);
  binding.meshes.set(command.slotId, rebuilt);
  if (replacesShown) noteReplacesDrawnVisual(rebuilt);
  updateComponentIllumination(rebuilt);
  for (const start of deferredModels) void start().catch(() => {});
  stampOverlayPick(rebuilt, command);
  // A rebuilt mesh loses its material, so re-apply the recorded assignment.
  if (!stagedText) applyMaterialToActorMeshes(binding, command.slotId, rebuilt);
  setPlayVisualVisibility(binding, rebuilt, lastVisible ?? binding.liveSlots.has(command.slotId));
  refreshPlayActiveCamera(scene, binding);
  binding.onVisualChanged?.(command.slotId);
}

function stampOverlayPick(mesh: Mesh, command: AssignMeshCommand): void {
  if (!command.hitTest && !command.actorGuid) return;
  const apply = (target: AbstractMesh) => {
    target.metadata = {
      ...(typeof target.metadata === "object" && target.metadata
        ? target.metadata
        : {}),
      overlayHitTest: command.hitTest,
      overlayActorGuid: command.actorGuid,
      overlayHasButton: command.hasButton === true,
      overlayButtonComponentId: command.buttonComponentId,
    };
    const control = uiControl2DMesh(target);
    if (control) {
      target.metadata.overlayHasButton = false;
      target.metadata.overlayHitTest = control.properties.enabled && control.classId !== "2DProgressBarComponent" ? "block" : "ignore";
      target.isPickable = target.metadata.overlayHitTest === "block";
      return;
    }
    if (target.metadata?.uiControl2DDecoration || target.metadata?.uiControl2DOption) {
      target.isPickable = target.metadata?.uiControl2DOption === true;
      return;
    }
    const joystick = joystick2DMesh(target);
    if (joystick) {
      target.metadata.overlayHitTest = joystick.properties.enabled ? "block" : "ignore";
      target.metadata.overlayHasButton = false;
      target.isPickable = joystick.properties.enabled;
    } else if (target.metadata?.joystick2DThumb) {
      target.isPickable = false;
    } else if (command.hitTest) {
      target.isPickable = command.hitTest !== "ignore";
    }
  };
  apply(mesh);
  for (const child of mesh.getChildMeshes()) {
    // LOD levels draw in place of their master and are never pick targets.
    if (child.isBlocked) continue;
    if ((child.metadata as { text2dGlyph?: boolean } | null)?.text2dGlyph) {
      child.isPickable = false;
      continue;
    }
    apply(child);
  }
}

function disposeSlotVisuals(
  binding: SnapshotSceneBinding,
  slotId: number,
): void {
  cancelPendingVisualReplacement(binding, slotId);
  binding.meshes.get(slotId)?.dispose();
  binding.meshes.delete(slotId);
  binding.spriteOverlays?.get(slotId)?.dispose();
  binding.spriteOverlays?.delete(slotId);
  invalidateSlotAnimLoad(binding, slotId);
  binding.lights.get(slotId)?.dispose();
  binding.lights.delete(slotId);
  binding.cameras.get(slotId)?.dispose();
  binding.cameras.delete(slotId);
}

function sameComponentVisuals(previous: readonly AssignMeshPart[], next: readonly AssignMeshPart[]): boolean {
  if (previous.length !== next.length) return false;
  // Illumination property writes must not replace an actor's working meshes or
  // reset its spring-arm lag. Every other part field still requires assignment.
  return previous.every((part, index) => sameJsonObject(part, next[index]!, illuminationFields));
}

const illuminationFields: ReadonlySet<string> = new Set(["light", "camera"]);

const jsonOmitted = (value: unknown): boolean => value === undefined || typeof value === "function" || typeof value === "symbol";
const jsonNull = (value: unknown): boolean => value === null || typeof value === "number" && !Number.isFinite(value);

/** Whether JSON.stringify renders both values identically, key order included, without building the strings. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // As an array element JSON renders what it cannot represent as null, like NaN and Infinity.
  if (jsonOmitted(a) || jsonNull(a)) return jsonOmitted(b) || jsonNull(b);
  if (jsonOmitted(b) || jsonNull(b) || typeof a !== "object" || typeof b !== "object") return false;
  if (typeof (a as { toJSON?: unknown }).toJSON === "function" || typeof (b as { toJSON?: unknown }).toJSON === "function")
    return JSON.stringify(a) === JSON.stringify(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!sameJson(a[index], b[index])) return false;
    return true;
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b) && a.constructor === b.constructor && !(a instanceof DataView)) {
    // Typed arrays render as objects keyed by index; compare the elements directly.
    const left = a as unknown as ArrayLike<number>, right = b as unknown as ArrayLike<number>;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      const x = left[index]!, y = right[index]!;
      if (x !== y && (Number.isFinite(x) || Number.isFinite(y))) return false;
    }
    return true;
  }
  return sameJsonObject(a as object, b as object);
}

/** Own enumerable keys in order, skipping `skip` and the values JSON leaves out of objects. */
function sameJsonObject(a: object, b: object, skip?: ReadonlySet<string>): boolean {
  const left = Object.keys(a), right = Object.keys(b);
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  let i = 0, j = 0;
  for (;;) {
    while (i < left.length && (skip?.has(left[i]!) || jsonOmitted(x[left[i]!]))) i++;
    while (j < right.length && (skip?.has(right[j]!) || jsonOmitted(y[right[j]!]))) j++;
    if (i === left.length || j === right.length) return i === left.length && j === right.length;
    if (left[i] !== right[j] || !sameJson(x[left[i]!], y[right[j]!])) return false;
    i++; j++;
  }
}

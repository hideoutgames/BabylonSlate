import {
  Quaternion,
  UniversalCamera,
  Vector3,
  type Camera,
  type Light,
  type Matrix,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { sceneShadowController } from "./shadow-controller";
import { createPrimitiveMesh } from "./scene-loader";
import {
  AUTHORED_CAMERA_PREFIX,
  AUTHORED_LIGHT_PREFIX,
  applyAuthoredCameraProperties,
  createPlayLight,
  updateAuthoredCameraTransform,
  updateAuthoredLightTransform,
  type AuthoredLightProperties,
} from "./scene-illumination";
import { snapToPixelGrid } from "./pixel-perfect";
import type {
  AssignMeshPart,
  PlayVisualTargets,
  SnapshotSceneBinding,
} from "./snapshot-binding";
import { markPlayHelperVisual } from "./snapshot-visibility";

export type ComponentIllumination = {
  mesh: Mesh;
  componentId?: string;
  light?: Light;
  camera?: Camera;
  lightProperties?: AuthoredLightProperties;
};
const componentIllumination = new WeakMap<Mesh, ComponentIllumination>();
const actorIllumination = new WeakMap<Mesh, ComponentIllumination[]>();

export function componentIlluminationOf(mesh: Mesh): ComponentIllumination | undefined {
  return componentIllumination.get(mesh);
}

/** Helpers whose meshes drive a light or camera, on a slot's visual root. */
export function actorIlluminationOf(root: Mesh): readonly ComponentIllumination[] | undefined {
  return actorIllumination.get(root);
}

export function hasActorIllumination(root: Mesh): boolean {
  return actorIllumination.has(root);
}

export function setActorIllumination(root: Mesh, helpers: ComponentIllumination[]): void {
  actorIllumination.set(root, helpers);
}

export const PLAY_FREE_CAM_NAME = "playFreeCam";

/** Resolve the game listener/camera independently of a viewport-owned free camera. */
export function resolvePlayGameCamera(scene: Scene, binding: SnapshotSceneBinding): Camera | null {
  const possessed = binding.possessedCameraSlotId !== null ? binding.cameras.get(binding.possessedCameraSlotId) : undefined;
  if (possessed && !possessed.isDisposed()) return possessed;
  const named = binding.defaultCameraSlotId !== null ? binding.cameras.get(binding.defaultCameraSlotId) : undefined;
  if (named && !named.isDisposed()) return named;
  return scene.getCameraByName("camera");
}

export function refreshPlayActiveCamera(
  scene: Scene,
  binding: SnapshotSceneBinding,
): void {
  if (scene.activeCamera?.name === PLAY_FREE_CAM_NAME) return;
  const camera = resolvePlayGameCamera(scene, binding);
  if (camera) scene.activeCamera = camera;
}

export function applyPlayShadows(scene: Scene): void {
  const shadows = sceneShadowController(scene);
  shadows.sync();
}

export function applyPossessCamera(
  scene: Scene,
  binding: SnapshotSceneBinding,
  slotId: number,
): void {
  binding.possessedCameraSlotId = slotId;
  refreshPlayActiveCamera(scene, binding);
}

/** A helper kind's hidden mesh, and the light or camera it drives when it has one. */
export function createPlayHelperMesh(
  scene: Scene,
  slotId: number,
  name: string,
  meshKind: string | null | undefined,
  binding: SnapshotSceneBinding | undefined,
  targets: PlayVisualTargets | undefined,
  illuminationPart: AssignMeshPart | undefined,
): Mesh {
  const mesh = createPrimitiveMesh(scene, name, null);
  markPlayHelperVisual(mesh);
  const helper: ComponentIllumination = { mesh, componentId: illuminationPart?.componentId };
  if (meshKind?.startsWith("light:") && binding) {
    const kind = meshKind.slice("light:".length);
    const lights = targets?.lights ?? binding.lights;
    const lightName = `${AUTHORED_LIGHT_PREFIX}${slotId}${lights.has(slotId) ? `|${illuminationPart?.componentId ?? name}` : ""}`;
    const props = illuminationPart?.light ?? binding.lightProps.get(slotId);
    const light = createPlayLight(scene, lightName, kind, props);
    if (!lights.has(slotId)) lights.set(slotId, light);
    helper.light = light;
    helper.lightProperties = props;
    if (targets) light.setEnabled(false);
    else if (!illuminationPart) applyPlayShadows(scene);
  }
  if (meshKind === "camera" && binding) {
    const cameras = targets?.cameras ?? binding.cameras;
    const camera = new UniversalCamera(
      `${AUTHORED_CAMERA_PREFIX}${slotId}${cameras.has(slotId) ? `|${illuminationPart?.componentId ?? name}` : ""}`,
      Vector3.Zero(),
      scene,
    );
    camera.minZ = 0.1;
    camera.maxZ = 1000;
    camera.rotationQuaternion = Quaternion.Identity();
    camera.rotation.set(0, 0, 0);
    camera.detachControl();
    camera.inputs.clear();
    const props = illuminationPart?.camera ?? binding.cameraProps.get(slotId);
    if (props) applyAuthoredCameraProperties(camera, props);
    if (!cameras.has(slotId) || props?.isDefault) cameras.set(slotId, camera);
    helper.camera = camera;
    if (!targets) refreshPlayActiveCamera(scene, binding);
  }
  if (helper.light || helper.camera) {
    componentIllumination.set(mesh, helper);
    actorIllumination.set(mesh, [helper]);
    mesh.onDisposeObservable.addOnce(() => {
      helper.light?.dispose();
      helper.camera?.dispose();
      const lights = targets?.lights ?? binding?.lights;
      const cameras = targets?.cameras ?? binding?.cameras;
      if (helper.light && lights?.get(slotId) === helper.light) lights.delete(slotId);
      if (helper.camera && cameras?.get(slotId) === helper.camera) cameras.delete(slotId);
    });
  }
  return mesh;
}

const scratchAnchorScale = new Vector3();
const scratchAnchorRotation = new Quaternion();
const scratchAnchorPosition = new Vector3();

/**
 * World matrix behind the last transform written to each helper light or
 * camera. The write is a pure function of it, so an identical matrix is
 * skipped. Whatever else moves the driven object after the write must drop its
 * entry, or the unchanged matrix would leave that move in place.
 */
const writtenIlluminationWorlds = new WeakMap<Light | Camera, Float64Array>();

/** Whether `world` differs from the matrix last written to `driven`; records it when it does. */
function illuminationWorldChanged(driven: Light | Camera, world: Matrix): boolean {
  const next = world.m;
  const last = writtenIlluminationWorlds.get(driven);
  if (!last) {
    const first = new Float64Array(16);
    first.set(next);
    writtenIlluminationWorlds.set(driven, first);
    return true;
  }
  for (let i = 0; i < 16; i++) {
    if (last[i] !== next[i]) {
      last.set(next);
      return true;
    }
  }
  return false;
}

/**
 * Component meshes include every attachment and spring-arm socket transform.
 * Those ancestors are moved in place by other passes, so the matrix is always
 * recomputed; only the decompose and the light or camera write are skipped
 * when it matches what was last written.
 */
export function updateComponentIllumination(root: Mesh): void {
  for (const helper of actorIllumination.get(root) ?? []) {
    const world = helper.mesh.computeWorldMatrix(true);
    const driven = helper.camera ?? helper.light;
    if (driven && !illuminationWorldChanged(driven, world)) continue;
    world.decompose(scratchAnchorScale, scratchAnchorRotation, scratchAnchorPosition);
    if (helper.light) updateAuthoredLightTransform(helper.light, scratchAnchorPosition, scratchAnchorRotation);
    if (helper.camera) updateAuthoredCameraTransform(helper.camera, scratchAnchorPosition, scratchAnchorRotation);
  }
}

export function snapPlayCameraToPixelGrid(
  scene: Scene,
  binding: SnapshotSceneBinding,
): void {
  if (!binding.pixelPerfect) return;
  const camera = scene.activeCamera;
  if (!camera) return;
  const ppu =
    binding.pixelsPerUnit && binding.pixelsPerUnit > 0
      ? binding.pixelsPerUnit
      : 100;
  const { x, y } = camera.position;
  const snappedX = snapToPixelGrid(x, ppu);
  const snappedY = snapToPixelGrid(y, ppu);
  camera.position.x = snappedX;
  camera.position.y = snappedY;
  // The snap moved the camera off its written pose; an unchanged pose must be rewritten.
  if (snappedX !== x || snappedY !== y) writtenIlluminationWorlds.delete(camera);
}

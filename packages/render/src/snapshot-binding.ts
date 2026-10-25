import {
  Mesh,
  type AbstractMesh,
  type Camera,
  type Light,
  type Material,
  type Scene,
} from "@babylonjs/core";
import type {
  CommandMessage,
  MaterialParameterValue,
} from "@haptic/bridge";
import type {
  OverlayVisualStyle,
  SkyboxFaces,
  Text2DProperties,
  Text3DProperties,
} from "@haptic/core";
import type { MeshAssetContext } from "./mesh-assets";
import type { OverlayPanelMeshOptions } from "./overlay-panel-mesh";
import type {
  AuthoredCameraProperties,
  AuthoredLightProperties,
} from "./scene-illumination";
import type { BoneAttachment } from "./bone-attachment";
import type { MaterialResolveOptions } from "./material-library";
import { AreaRectLightGroup } from "./area-rect-light";

export type AssignMeshCommand = Extract<CommandMessage, { type: "assignMesh" }>;
export type AssignMeshPart = NonNullable<AssignMeshCommand["parts"]>[number];

export interface SnapshotSceneBinding extends MeshAssetContext {
  ragdoll?: import("./ragdoll-pose").RagdollPoseController;
  /** Runtime component records outlive asynchronous mesh realization. */
  outlines: Map<number, { actorId: string; bindings: import("@haptic/core").OutlineBinding[] }>;
  deformers: Map<number, { actorId: string; revision: number; bindings: import("@haptic/core").DeformerBinding[] }>;
  fogVolumes: Map<number, { actorId: string; bindings: import("@haptic/core").FogVolumeBinding[] }>;
  reflectionProbes: Map<number, { actorId: string; bindings: import("@haptic/core").ReflectionProbeBinding[] }>;
  onVisualChanged?: (slotId: number) => void;
  areaLights: Map<number, AreaRectLightGroup>;
  meshes: Map<number, Mesh>;
  boneAttachments: Map<number, BoneAttachment>;
  lights: Map<number, Light>;
  cameras: Map<number, Camera>;
  lightProps: Map<number, AuthoredLightProperties>;
  cameraProps: Map<number, AuthoredCameraProperties>;
  skyboxProps: Map<number, { size: number; faces: SkyboxFaces }>;
  text3dProps: Map<number, Text3DProperties>;
  text2dProps: Map<number, Text2DProperties>;
  overlayPanelProps: Map<number, OverlayPanelMeshOptions>;
  overlayStyles: Map<number, Map<string, OverlayVisualStyle>>;
  /** Snap the Play camera to the pixel grid (project `twoD.pixelPerfect`). */
  pixelPerfect?: boolean;
  /** Worker simulation clock, retained while paused and across visual rebuilds. */
  tilemapAnimationTimeMs?: number;
  tilemapAnimationScenes?: Set<Scene>;
  /** Reused each apply — no per-frame Set allocation. */
  liveSlots: Set<number>;
  /** Reused structural-pass results, indexed by the current snapshot actor. */
  snapshotMeshes: Array<Mesh | null>;
  /** Slot ids observed in an applied snapshot; gates absence-retire so
   * command-built visuals survive a stale buffer that predates them. */
  seenSlots: Set<number>;
  /** meshKind from assignMesh, keyed by slotId. */
  meshKinds: Map<number, string | null>;
  /** Sprite / mesh asset guid from assignMesh, keyed by slotId. */
  meshAssetGuids: Map<number, string | null>;
  /** Extra component parts from assignMesh, keyed by slotId. */
  meshParts: Map<number, NonNullable<AssignMeshCommand["parts"]>>;
  meshSorting: Map<number, Pick<AssignMeshCommand, "actorGuid" | "sortingLayer" | "orderInLayer">>;
  /** Second sprite mesh used for two-layer clip crossfades. */
  spriteOverlays?: Map<number, Mesh>;
  /** Per-slot AnimationGroups keyed after model load (not the global scene list). */
  slotAnimationGroups?: Map<
    number,
    Array<{
      name: string;
      from: number;
      to: number;
      clipAssetGuid?: string;
      pause(): void;
      goToFrame(frame: number): void;
      setWeightForAllAnimatables?(weight: number): void;
      dispose?(): void;
    }>
  >;
  /** Last animState per slot, replayed when groups become available. */
  pendingAnimState?: Map<
    number,
    Extract<CommandMessage, { type: "animState" }>
  >;
  /** In-flight GLB AnimationGroup loads, keyed by slotId. */
  slotAnimLoads?: Map<number, Promise<void>>;
  /** Cancels in-flight loads when incremented. */
  slotAnimEpoch?: Map<number, number>;
  /** Called after a slot's AnimationGroups are registered (replay pending seek). */
  slotAnimReady?: (slotId: number) => void;
  /** Move external render users to a prepared successor before retiring its predecessor. */
  slotVisualReady?: (slotId: number, successor: Mesh) => void;
  defaultCameraSlotId: number | null;
  possessedCameraSlotId: number | null;
  /** Material asset guid per slot (whole actor), keyed by slotId. */
  materialAssetGuids: Map<number, string | null>;
  /** Material asset guid per component, keyed by `slotId|componentId`. */
  componentMaterialGuids: Map<string, string | null>;
  /** Component identity for optimized visuals whose mesh is named only by actor slot. */
  primaryComponentIds: Map<number, string>;
  /** Private parameter values survive visual rebuilds but not reassignment/despawn. */
  materialParameters: Map<
    string,
    {
      materialAssetGuid: string;
      values: Map<string, MaterialParameterValue>;
    }
  >;
  releaseMaterialInstance?: (instanceKey: string, assetGuid?: string) => void;
  validateMaterialParameter?: (
    assetGuid: string,
    name: string,
    value: MaterialParameterValue,
  ) => boolean;
  /** Resolves an assigned Material guid to a scene-local compiled material. */
  resolveMaterial?: (
    assetGuid: string,
    options?: MaterialResolveOptions & { scene?: Scene },
  ) => Material | null;
  /** Overlay Play: create missing visuals in the SceneLayer scene for this slot. */
  sceneForSlot?: (slotId: number) => Scene | null;
  /** Overlay Play: slot is tagged to a SceneLayer even if that scene is not live yet. */
  isOverlaySlot?: (slotId: number) => boolean;
}

/**
 * Map keyed `${slotId}|...` that indexes its keys by slot, so retiring one slot
 * visits only its own entries rather than scanning every slot's. Every write
 * and delete goes through `set`/`delete`/`clear`, wherever it is made.
 */
export class SlotKeyedMap<V> extends Map<string, V> {
  private readonly slotKeys = new Map<string, Set<string>>();

  override set(key: string, value: V): this {
    super.set(key, value);
    const end = key.indexOf("|");
    if (end >= 0) {
      const slot = key.slice(0, end);
      let keys = this.slotKeys.get(slot);
      if (!keys) this.slotKeys.set(slot, keys = new Set());
      keys.add(key);
    }
    return this;
  }

  override delete(key: string): boolean {
    const deleted = super.delete(key);
    const end = key.indexOf("|");
    if (deleted && end >= 0) {
      const slot = key.slice(0, end);
      const keys = this.slotKeys.get(slot);
      keys?.delete(key);
      if (keys && keys.size === 0) this.slotKeys.delete(slot);
    }
    return deleted;
  }

  override clear(): void {
    super.clear();
    this.slotKeys.clear();
  }

  /** Live, in insertion order: the same keys and order as filtering `keys()` by the slot prefix. */
  keysOfSlot(slotId: number): Iterable<string> {
    return this.slotKeys.get(String(slotId)) ?? [];
  }
}

/** Keys of one slot; stores a caller swapped in for a plain Map fall back to the scan. */
export function slotKeysOf(store: Map<string, unknown>, slotId: number): Iterable<string> {
  if (store instanceof SlotKeyedMap) return store.keysOfSlot(slotId);
  const prefix = `${slotId}|`;
  return [...store.keys()].filter((key) => key.startsWith(prefix));
}

export function createSnapshotSceneBinding(): SnapshotSceneBinding {
  return {
    outlines: new Map(),
    deformers: new Map(),
    fogVolumes: new Map(),
    reflectionProbes: new Map(),
    meshes: new Map(),
    boneAttachments: new Map(),
    lights: new Map(),
    cameras: new Map(),
    lightProps: new Map(),
    areaLights: new Map(),
    cameraProps: new Map(),
    skyboxProps: new Map(),
    text3dProps: new Map(),
    text2dProps: new Map(),
    overlayPanelProps: new Map(),
    overlayStyles: new Map(),
    liveSlots: new Set(),
    snapshotMeshes: [],
    seenSlots: new Set(),
    meshKinds: new Map(),
    meshAssetGuids: new Map(),
    meshParts: new Map(),
    meshSorting: new Map(),
    spriteOverlays: new Map(),
    slotAnimationGroups: new Map(),
    pendingAnimState: new Map(),
    slotAnimLoads: new Map(),
    slotAnimEpoch: new Map(),
    defaultCameraSlotId: null,
    possessedCameraSlotId: null,
    materialAssetGuids: new Map(),
    componentMaterialGuids: new SlotKeyedMap(),
    primaryComponentIds: new Map(),
    materialParameters: new SlotKeyedMap(),
  };
}

export type SceneNode = import("@babylonjs/core").Node;

/**
 * Imported glTF child names are arbitrary; their component is on an ancestor.
 * A walk over one slot's meshes passes a shared `nearest` memo, so each node's
 * name is parsed once rather than once per descendant.
 */
export function componentIdForPlayMesh(
  mesh: AbstractMesh,
  slotId: number,
  binding: SnapshotSceneBinding,
  nearest?: Map<SceneNode, string | null>,
): string | null {
  let id: string | null = null;
  const climbed: SceneNode[] = [];
  for (let node: SceneNode | null = mesh; node; node = node.parent) {
    climbed.push(node);
    const known = nearest?.get(node);
    if (known !== undefined) { id = known; break; }
    id = componentIdOfPlayMesh(node.name, slotId) || null;
    if (id) break;
  }
  if (nearest) for (const node of climbed) nearest.set(node, id);
  return id ?? binding.primaryComponentIds.get(slotId) ?? null;
}

export function isMesh(value: AbstractMesh): value is Mesh {
  return value instanceof Mesh;
}

/** `actor-<slot>|<componentId>` identifies one visual component's mesh. */
function componentIdOfPlayMesh(
  meshName: string,
  slotId: number,
): string | null {
  const prefix = `actor-${slotId}|`;
  if (!meshName.startsWith(prefix)) return null;
  const rest = meshName.slice(prefix.length);
  return rest.includes(":") ? rest.slice(0, rest.indexOf(":")) : rest;
}

export function playComponentMeshName(
  slotId: number,
  componentId: string,
): string {
  return `actor-${slotId}|${componentId}`;
}

/** Exact component roots, including the single-component actor fast path. */
export function meshForPlayComponent(binding: SnapshotSceneBinding, slotId: number, componentId: string): Mesh | null {
  const root = binding.meshes.get(slotId);
  if (!root || root.isDisposed()) return null;
  if (root.metadata?.playActorOrigin !== true) {
    return binding.primaryComponentIds.get(slotId) === componentId ? root : null;
  }
  const name = playComponentMeshName(slotId, componentId);
  return root.getChildMeshes().find((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.name === name) ?? null;
}

export function partsNeedOrigin(
  parts: readonly AssignMeshPart[] | undefined,
): boolean {
  if (!parts || parts.length === 0) return false;
  if (parts.length > 1 || parts.some((part) => part.light || part.camera || part.parentTransforms?.length || part.meshKind === "water" || part.meshKind === "waterRemoval" || part.meshKind === "cable" || part.meshKind === "mirror" || part.meshKind === "2djoystick" || part.meshKind === "2dcontrol" || part.meshKind === "dynamicRuntimeMesh")) return true;
  const part = parts[0]!;
  return (
    Boolean(part.landscape || part.foliage) ||
    part.position[0] !== 0 ||
    part.position[1] !== 0 ||
    part.position[2] !== 0 ||
    part.rotation[0] !== 0 ||
    part.rotation[1] !== 0 ||
    part.rotation[2] !== 0 ||
    part.rotation[3] !== 1 ||
    part.scale[0] !== 1 ||
    part.scale[1] !== 1 ||
    part.scale[2] !== 1
  );
}

export type DeferredModelLoad = (preparation?: { ownsLoad: () => boolean }) => Promise<void>;

export type PlayVisualTargets = {
  spriteOverlays: Map<number, Mesh>;
  lights: Map<number, Light>;
  cameras: Map<number, Camera>;
};

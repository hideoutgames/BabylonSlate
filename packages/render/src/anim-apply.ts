import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { CommandMessage } from "@haptic/bridge";
import type { SpriteAnimationPayload, SpritePayload } from "@haptic/assets";
import { flipSpriteAnimationFrame, spriteAnimationFrameAt } from "@haptic/assets";
import { setSpriteQuadSize, setSpriteQuadUvs } from "./sprite-quad";
import { applySpriteVisibility } from "./mesh-assets";
import type { SnapshotSceneBinding } from "./snapshot-apply";
import type { AnimLayerMaskRef } from "@haptic/core";
import { applyPose, poseRigFor, type PoseClip, type PoseLayering } from "./anim-pose";

/**
 * Bind a Sprite Animation asset frame (texture, region, size, pivot) onto the sprite quad; a sheet cell shows its
 * UVs, other frames the whole texture. `flipX` / `flipY` mirror it about its pivot (Flip Frame).
 */
export function applySpriteAnimationAssetFrame(
  mesh: Mesh,
  payload: SpriteAnimationPayload,
  normalisedTime: number,
  options?: {
    applyTexture?: (mesh: Mesh, textureGuid: string | null | undefined) => void;
    pixelsPerUnit?: number;
    flipX?: boolean;
    flipY?: boolean;
  },
): void {
  const authored = spriteAnimationFrameAt(payload, normalisedTime);
  if (!authored) return;
  const frame = flipSpriteAnimationFrame(authored, options?.flipX, options?.flipY);
  options?.applyTexture?.(mesh, frame.textureGuid || null);
  setSpriteQuadUvs(mesh, frame.uv);
  const ppu =
    options?.pixelsPerUnit && options.pixelsPerUnit > 0
      ? options.pixelsPerUnit
      : 100;
  // The frame's pivot sits on the actor origin, where the box2d collider is centred.
  setSpriteQuadSize(mesh, (frame.width ?? 100) / ppu, (frame.height ?? 100) / ppu, frame.pivot);
}

type AnimStateCommand = Extract<CommandMessage, { type: "animState" }>;

export type AnimClipLayer = NonNullable<AnimStateCommand["layers"]>[number];

interface SpriteAnimSlot {
  mesh: Mesh;
  payload: SpritePayload;
  overlayMesh?: Mesh;
  spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
  applyTexture?: (mesh: Mesh, textureGuid: string | null | undefined) => void;
}

export function resolvePlaySpriteSlot(
  binding: SnapshotSceneBinding,
  payloads: ReadonlyMap<string, SpritePayload> | undefined,
  slotId: number,
): SpriteAnimSlot | undefined {
  const mesh = binding.meshes.get(slotId);
  const guid = binding.meshAssetGuids.get(slotId);
  if (!mesh || !guid || !payloads) return undefined;
  const payload = payloads.get(guid);
  if (!payload) return undefined;
  return {
    mesh,
    payload,
    overlayMesh: binding.spriteOverlays?.get(slotId),
  };
}

export interface MissingAnimClip {
  slotId: number;
  clipName: string;
  clipAssetGuid?: string;
  clipKind: "animation" | "sprite";
}

/** Passes each missing clip on once per slot and clip, so a state that replays every frame reports it once. */
export function onceMissingClip(report: (info: MissingAnimClip) => void): (info: MissingAnimClip) => void {
  const reported = new Set<string>();
  return (info) => {
    const key = `${info.slotId}\0${info.clipKind}\0${info.clipAssetGuid ?? ""}\0${info.clipName}`;
    if (reported.has(key)) return;
    reported.add(key);
    report(info);
  };
}

interface SceneAnimHost {
  isPhysicsDriven?(slotId: number): boolean;
  /** The slot's own clips; layers resolve only from these, never another actor's. */
  getPoseClips(slotId: number): readonly PoseClip[];
  getSpriteSlot?(slotId: number): SpriteAnimSlot | undefined;
  onMissingClip?(info: MissingAnimClip): void;
}

function animStateLayers(command: AnimStateCommand): AnimClipLayer[] {
  if (command.layers && command.layers.length > 0) {
    return command.layers;
  }
  if (!command.clipName && !command.clipAssetGuid) return [];
  return [
    {
      stateId: command.stateId,
      clipAssetGuid: command.clipAssetGuid ?? "",
      clipName: command.clipName ?? "",
      clipKind: command.clipKind ?? "animation",
      normalisedTime: command.normalisedTime,
      weight: command.blendWeights[command.stateId] ?? 1,
    },
  ];
}

function clipMatches(
  entry: Pick<PoseClip, "name" | "clipAssetGuid">,
  clipName: string,
  clipAssetGuid?: string,
): boolean {
  if (entry.name !== clipName) return false;
  if (!clipAssetGuid) return true;
  return entry.clipAssetGuid === clipAssetGuid;
}

const NO_CLIPS: readonly PoseClip[] = [];

/** Below this a scan beats a map lookup, and short lists skip the index entirely. */
const INDEXED_CLIPS = 6;
/**
 * Clips by name, in list order, each with its position. A slot's clip list is
 * replaced whole when a model's clips load or unload and a bound clip's name
 * and clip guid are fixed, so the list's identity and length key its index. An
 * in-place replacement of the same length is caught too: a hit must still sit
 * at its recorded position, and a miss is confirmed against a snapshot of the
 * list, either of which rebuilds the index. The one edit left unseen is an
 * in-place replacement that makes an earlier clip than the hit match as well.
 */
interface ClipEntry {
  clip: PoseClip;
  position: number;
}
interface ClipIndex {
  members: readonly PoseClip[];
  byName: Map<string, ClipEntry[]>;
  /** By name and clip guid (`clipKey`), so a lookup naming both finds its clip without scanning same-name clips. */
  byClip: Map<string, ClipEntry[]>;
}

/** A clip's name and clip guid as one key; NUL separates them, as neither holds it. */
function clipKey(name: string, clipAssetGuid: string | undefined): string {
  return `${name}\u0000${clipAssetGuid ?? ""}`;
}
const clipIndexes = new WeakMap<readonly PoseClip[], ClipIndex>();

function buildClipIndex(clips: readonly PoseClip[]): ClipIndex {
  const byName = new Map<string, ClipEntry[]>();
  const byClip = new Map<string, ClipEntry[]>();
  const add = (map: Map<string, ClipEntry[]>, key: string, entry: ClipEntry) => {
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  };
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const entry = { clip, position: i };
    add(byName, clip.name, entry);
    add(byClip, clipKey(clip.name, clip.clipAssetGuid), entry);
  }
  const index = { members: clips.slice(), byName, byClip };
  clipIndexes.set(clips, index);
  return index;
}

function indexedFrom(index: ClipIndex, clips: readonly PoseClip[]): boolean {
  if (index.members.length !== clips.length) return false;
  for (let i = 0; i < clips.length; i++) if (index.members[i] !== clips[i]) return false;
  return true;
}

function findIndexedClip(
  clips: readonly PoseClip[],
  clipName: string,
  clipAssetGuid?: string,
): PoseClip | undefined {
  let index = clipIndexes.get(clips);
  let fresh = false;
  if (!index || index.members.length !== clips.length) {
    index = buildClipIndex(clips);
    fresh = true;
  }
  for (;;) {
    let moved = false;
    // In list order either way: the entries naming the guid as well hold only matches.
    const named = clipAssetGuid ? index.byClip.get(clipKey(clipName, clipAssetGuid)) : index.byName.get(clipName);
    if (named) {
      for (let i = 0; i < named.length; i++) {
        const entry = named[i]!;
        if (!clipMatches(entry.clip, clipName, clipAssetGuid)) continue;
        if (clips[entry.position] === entry.clip) return entry.clip;
        moved = true;
        break;
      }
    }
    // A hit that left its position, or a miss in a list edited in place, rebuilds once.
    if (fresh || (!moved && indexedFrom(index, clips))) return undefined;
    index = buildClipIndex(clips);
    fresh = true;
  }
}

/** The first clip, in list order, with the clip's name (and guid when one is given). */
function findClip(
  clips: readonly PoseClip[],
  clipName: string,
  clipAssetGuid?: string,
): PoseClip | undefined {
  if (clips.length >= INDEXED_CLIPS) return findIndexedClip(clips, clipName, clipAssetGuid);
  for (let i = 0; i < clips.length; i++) {
    if (clipMatches(clips[i]!, clipName, clipAssetGuid)) return clips[i];
  }
  return undefined;
}

/** False when the layer names no loaded Sprite Animation: the quad keeps showing what it showed. */
function applySpriteLayer(
  slot: SpriteAnimSlot,
  mesh: Mesh,
  layer: AnimClipLayer,
): boolean {
  const animation = layer.clipAssetGuid
    ? slot.spriteAnimations?.get(layer.clipAssetGuid)
    : undefined;
  if (!animation) return false;
  applySpriteAnimationAssetFrame(mesh, animation, layer.normalisedTime, {
    applyTexture: slot.applyTexture,
    pixelsPerUnit: slot.payload.pixelsPerUnit,
    flipX: layer.flipX,
    flipY: layer.flipY,
  });
  return true;
}

function applySpriteLayers(
  scene: SceneAnimHost,
  slotId: number,
  primary: AnimClipLayer,
  secondary: AnimClipLayer | undefined,
): void {
  const slot = scene.getSpriteSlot?.(slotId);
  if (!slot || !applySpriteLayer(slot, slot.mesh, primary)) {
    scene.onMissingClip?.({
      slotId,
      clipName: primary.clipName,
      clipAssetGuid: primary.clipAssetGuid,
      clipKind: "sprite",
    });
    return;
  }
  applySpriteVisibility(slot.mesh, primary.weight);
  if (slot.overlayMesh) {
    applySpriteVisibility(
      slot.overlayMesh,
      secondary && applySpriteLayer(slot, slot.overlayMesh, secondary) ? secondary.weight : 0,
    );
  }
}

// Per-call scratch (animState runs per animated actor per tick): the clip
// layers, then each distinct clip once with its frame and summed weight.
// Entries are cleared after each call so no clip outlives its Scene here.
// Not re-entrant; host callbacks only look up or warn.
const poseClips: (PoseClip | undefined)[] = [];
const poseLayers: (AnimClipLayer | undefined)[] = [];
const poseFrames: number[] = [];
const poseWeights: number[] = [];
const poseMasks: (readonly AnimLayerMaskRef[] | undefined)[] = [];

function sameMasks(a: readonly AnimLayerMaskRef[] | undefined, b: readonly AnimLayerMaskRef[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.blend !== b[i]!.blend || a[i]!.input !== b[i]!.input) return false;
  return true;
}

/** The clip's frame at a layer's normalised time (clamped to the clip). */
function clipFrame(clip: PoseClip, normalisedTime: number): number {
  const t = Number.isFinite(normalisedTime) ? Math.min(1, Math.max(0, normalisedTime)) : 0;
  return clip.from + t * Math.max(0, clip.to - clip.from);
}

/**
 * Poses a slot from its animation state: 3D clip layers blend by weight through the slot's pose rig (`applyPose`),
 * and sprite layers bake their frame onto the quad (two layers crossfade through its overlay).
 */
export function applyAnimStateToScene(
  scene: SceneAnimHost,
  command: AnimStateCommand,
): void {
  if (scene.isPhysicsDriven?.(command.slotId)) return;
  const layers = animStateLayers(command);
  let spritePrimary: AnimClipLayer | undefined;
  let spriteSecondary: AnimClipLayer | undefined;
  let count = 0;
  const slotClips = scene.getPoseClips(command.slotId);
  try {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      if (layer.clipKind === "sprite") {
        if (!spritePrimary) spritePrimary = layer;
        else spriteSecondary ??= layer;
        continue;
      }
      // A state with no clip names none: it plays nothing, so its slot rests and nothing is missing.
      if (!layer.clipName && !layer.clipAssetGuid) continue;
      // A slot without its own clip (still loading, or not on its Model) must
      // not play another actor's clip of the same name.
      const clip = findClip(slotClips, layer.clipName, layer.clipAssetGuid);
      if (!clip) {
        scene.onMissingClip?.({
          slotId: command.slotId,
          clipName: layer.clipName,
          clipAssetGuid: layer.clipAssetGuid,
          clipKind: "animation",
        });
        continue;
      }
      // Layers sharing a clip (under the same Layered Blend inputs) play it once, at the current state's time, with
      // their weights summed.
      let at = -1;
      for (let j = 0; j < count; j++) {
        if (poseClips[j] === clip && sameMasks(poseMasks[j], layer.masks)) {
          at = j;
          break;
        }
      }
      if (at < 0) {
        poseClips[count] = clip;
        poseLayers[count] = layer;
        poseWeights[count] = layer.weight;
        poseMasks[count] = layer.masks;
        count++;
        continue;
      }
      poseWeights[at] += layer.weight;
      if (poseLayers[at]!.stateId !== command.stateId) poseLayers[at] = layer;
    }
    // What no layer plays rests.
    if (slotClips.length > 0) {
      for (let i = 0; i < count; i++) poseFrames[i] = clipFrame(poseClips[i]!, poseLayers[i]!.normalisedTime);
      const layering: PoseLayering | null = command.layerBlends?.length || command.boneModifiers?.length
        ? { masks: poseMasks, blends: command.layerBlends ?? [], modifiers: command.boneModifiers ?? [] }
        : null;
      applyPose(poseRigFor(slotClips), count, poseClips, poseFrames, poseWeights, layering);
    }
  } finally {
    for (let i = 0; i < count; i++) {
      poseClips[i] = undefined;
      poseLayers[i] = undefined;
      poseMasks[i] = undefined;
    }
  }
  if (spritePrimary) {
    applySpriteLayers(scene, command.slotId, spritePrimary, spriteSecondary);
  }
}

export function sceneAnimHostFromBinding(
  binding: SnapshotSceneBinding,
  options: {
    spritePayloads?: ReadonlyMap<string, SpritePayload>;
    spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
    applyTexture?: (mesh: Mesh, textureGuid: string | null | undefined) => void;
    onMissingClip?: (info: MissingAnimClip) => void;
  } = {},
): SceneAnimHost {
  return {
    isPhysicsDriven: (slotId) => binding.ragdoll?.isDriven(slotId) ?? false,
    getPoseClips: (slotId) => binding.slotPoseClips?.get(slotId) ?? NO_CLIPS,
    getSpriteSlot: (slotId) => {
      const slot = resolvePlaySpriteSlot(
        binding,
        options.spritePayloads,
        slotId,
      );
      if (!slot) return undefined;
      // The resolved slot is a fresh object; complete it in place.
      slot.spriteAnimations =
        options.spriteAnimations ?? binding.spriteAnimations;
      slot.applyTexture = options.applyTexture;
      return slot;
    },
    onMissingClip: options.onMissingClip,
  };
}

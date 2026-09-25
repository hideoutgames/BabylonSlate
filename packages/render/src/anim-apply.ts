import { Vector3, type Mesh } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import type { SpriteAnimationPayload, SpriteFrame, SpritePayload } from "@babylonslate/assets";
import {
  spriteAnimationFrameAt,
  spriteClipFrameAt,
} from "@babylonslate/assets";
import { applySpriteFrameUvs, setSpriteQuadSize } from "./sprite-quad";
import { applySpriteVisibility } from "./mesh-assets";
import type { SnapshotSceneBinding } from "./snapshot-apply";

/**
 * Gameplay animation clock lives in the worker. Render only seeks; it never
 * lets Babylon auto-advance a gameplay-relevant clip (engineplan §2.3).
 */
export interface SeekableAnimationGroup {
  from?: number;
  pause(): void;
  reset?(): void;
  goToFrame(frame: number): void;
  setWeightForAllAnimatables?(weight: number): void;
  /** Weighted seek blended by the next render's animation pass; a later seek or reset replaces it. */
  blendToFrame?(frame: number, weight: number): void;
}

function gameplayFrame(
  group: SeekableAnimationGroup,
  normalisedTime: number,
  durationFrames: number,
): number {
  const span = Math.max(0, durationFrames);
  const t = Number.isFinite(normalisedTime)
    ? Math.min(1, Math.max(0, normalisedTime))
    : 0;
  return (group.from ?? 0) + t * span;
}

export function seekGameplayAnimation(
  group: SeekableAnimationGroup,
  normalisedTime: number,
  durationFrames: number,
  weight = 1,
): void {
  group.pause();
  group.goToFrame(gameplayFrame(group, normalisedTime, durationFrames));
  group.setWeightForAllAnimatables?.(weight);
}

export function applySpriteAnimFrame(
  mesh: Mesh,
  payload: SpritePayload,
  clipName: string,
  normalisedTime: number,
): void {
  const frame = spriteClipFrameAt(payload, clipName, normalisedTime);
  if (frame) applySpriteFrameUvs(mesh, frame);
}

const spritePivots = new WeakMap<Mesh, { x: number; y: number }>();
const spritePivot = new Vector3();
/** Each Sprite Animation frame owns its whole texture; applySpriteFrameUvs reads only u/v/uSize/vSize. */
const FULL_TEXTURE_FRAME: SpriteFrame = {
  name: "sprite-animation",
  u: 0,
  v: 0,
  uSize: 1,
  vSize: 1,
  durationMs: 0,
  pivot: { x: 0.5, y: 0.5 },
};

/** Bind a Sprite Animation asset frame (full UVs, texture, pivot) onto the sprite quad. */
export function applySpriteAnimationAssetFrame(
  mesh: Mesh,
  payload: SpriteAnimationPayload,
  normalisedTime: number,
  options?: {
    applyTexture?: (mesh: Mesh, textureGuid: string | null | undefined) => void;
    pixelsPerUnit?: number;
  },
): void {
  const frame = spriteAnimationFrameAt(payload, normalisedTime);
  if (!frame) return;
  applySpriteFrameUvs(mesh, FULL_TEXTURE_FRAME);
  options?.applyTexture?.(mesh, frame.textureGuid || null);
  const ppu =
    options?.pixelsPerUnit && options.pixelsPerUnit > 0
      ? options.pixelsPerUnit
      : 100;
  const worldWidth = (frame.width ?? 100) / ppu;
  const worldHeight = (frame.height ?? 100) / ppu;
  setSpriteQuadSize(mesh, worldWidth, worldHeight);
  const x = (frame.pivot.x - 0.5) * worldWidth;
  const y = (0.5 - frame.pivot.y) * worldHeight;
  const previous = spritePivots.get(mesh);
  if (!previous || previous.x !== x || previous.y !== y) {
    mesh.setPivotPoint(spritePivot.set(x, y, 0));
    // A static actor's frozen matrix would otherwise keep the previous pivot.
    if (mesh.isWorldMatrixFrozen) mesh.freezeWorldMatrix();
    spritePivots.set(mesh, { x, y });
  }
}

export type AnimStateCommand = Extract<CommandMessage, { type: "animState" }>;

export type AnimClipLayer = NonNullable<AnimStateCommand["layers"]>[number];

export interface SpriteAnimSlot {
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

export type NamedSeekableGroup = SeekableAnimationGroup & {
  name: string;
  from: number;
  to: number;
  clipAssetGuid?: string;
};

export interface MissingAnimClip {
  slotId: number;
  clipName: string;
  clipAssetGuid?: string;
  clipKind: "animation" | "sprite";
}

export interface SceneAnimHost {
  animationGroups: NamedSeekableGroup[];
  getAnimationGroups?(slotId: number): readonly NamedSeekableGroup[];
  getAnimationGroup?(
    slotId: number,
    clipName: string,
    clipAssetGuid?: string,
  ): NamedSeekableGroup | undefined;
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

function groupMatchesClip(
  entry: Pick<NamedSeekableGroup, "name" | "clipAssetGuid">,
  clipName: string,
  clipAssetGuid?: string,
): boolean {
  if (entry.name !== clipName) return false;
  if (!clipAssetGuid) return true;
  return entry.clipAssetGuid === clipAssetGuid;
}

const NO_GROUPS: readonly NamedSeekableGroup[] = [];

function findClipGroup(
  groups: readonly NamedSeekableGroup[],
  clipName: string,
  clipAssetGuid?: string,
): NamedSeekableGroup | undefined {
  for (let i = 0; i < groups.length; i++) {
    if (groupMatchesClip(groups[i]!, clipName, clipAssetGuid)) return groups[i];
  }
  return undefined;
}

function resolveAnimationGroup(
  scene: SceneAnimHost,
  slotId: number,
  layer: AnimClipLayer,
): NamedSeekableGroup | undefined {
  const fromHost = scene.getAnimationGroup?.(
    slotId,
    layer.clipName,
    layer.clipAssetGuid,
  );
  if (fromHost) return fromHost;
  return findClipGroup(scene.animationGroups, layer.clipName, layer.clipAssetGuid);
}

function applySpriteLayer(
  slot: SpriteAnimSlot,
  mesh: Mesh,
  layer: AnimClipLayer,
): void {
  const animation = layer.clipAssetGuid
    ? slot.spriteAnimations?.get(layer.clipAssetGuid)
    : undefined;
  if (animation) {
    applySpriteAnimationAssetFrame(mesh, animation, layer.normalisedTime, {
      applyTexture: slot.applyTexture,
      pixelsPerUnit: slot.payload.pixelsPerUnit,
    });
    return;
  }
  applySpriteAnimFrame(mesh, slot.payload, layer.clipName, layer.normalisedTime);
}

function applySpriteLayers(
  scene: SceneAnimHost,
  slotId: number,
  primary: AnimClipLayer,
  secondary: AnimClipLayer | undefined,
): void {
  const slot = scene.getSpriteSlot?.(slotId);
  if (!slot) {
    scene.onMissingClip?.({
      slotId,
      clipName: primary.clipName,
      clipAssetGuid: primary.clipAssetGuid,
      clipKind: "sprite",
    });
    return;
  }
  applySpriteLayer(slot, slot.mesh, primary);
  applySpriteVisibility(slot.mesh, primary.weight);
  if (slot.overlayMesh) {
    if (secondary) {
      applySpriteLayer(slot, slot.overlayMesh, secondary);
      applySpriteVisibility(slot.overlayMesh, secondary.weight);
    } else {
      applySpriteVisibility(slot.overlayMesh, 0);
    }
  }
}

// Per-call scratch (animState runs per animated actor per tick): animation
// layers with their resolved groups, then one seek per distinct group.
// Entries are cleared after each call so no group outlives its Scene here.
// Not re-entrant; host callbacks only look up, reset, seek or warn.
const resolvedLayers: (AnimClipLayer | undefined)[] = [];
const resolvedGroups: (NamedSeekableGroup | undefined)[] = [];
const seekLayers: (AnimClipLayer | undefined)[] = [];
const seekGroups: (NamedSeekableGroup | undefined)[] = [];
const seekWeights: number[] = [];

function indexOfGroup(
  groups: readonly (NamedSeekableGroup | undefined)[],
  count: number,
  group: NamedSeekableGroup,
): number {
  for (let i = 0; i < count; i++) if (groups[i] === group) return i;
  return -1;
}

/** Seek weighted AnimationGroups, or bake sprite clip UVs (two-layer blend). */
export function applyAnimStateToScene(
  scene: SceneAnimHost,
  command: AnimStateCommand,
): void {
  const layers = animStateLayers(command);
  let spritePrimary: AnimClipLayer | undefined;
  let spriteSecondary: AnimClipLayer | undefined;
  let resolvedCount = 0;
  let seekCount = 0;
  try {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      if (layer.clipKind === "sprite") {
        if (!spritePrimary) spritePrimary = layer;
        else spriteSecondary ??= layer;
        continue;
      }
      resolvedLayers[resolvedCount] = layer;
      resolvedGroups[resolvedCount] = resolveAnimationGroup(scene, command.slotId, layer);
      resolvedCount++;
    }
    const slotGroups = scene.getAnimationGroups?.(command.slotId) ?? NO_GROUPS;
    for (let i = 0; i < slotGroups.length; i++) {
      const group = slotGroups[i]!;
      // Restore channels absent from the incoming clip before its pose is applied.
      if (indexOfGroup(resolvedGroups, resolvedCount, group) < 0) group.reset?.();
    }
    // Layers sharing a clip seek it once, at the current state's time.
    for (let i = 0; i < resolvedCount; i++) {
      const layer = resolvedLayers[i]!;
      const group = resolvedGroups[i];
      if (!group) {
        scene.onMissingClip?.({
          slotId: command.slotId,
          clipName: layer.clipName,
          clipAssetGuid: layer.clipAssetGuid,
          clipKind: "animation",
        });
        continue;
      }
      const seek = indexOfGroup(seekGroups, seekCount, group);
      if (seek < 0) {
        seekGroups[seekCount] = group;
        seekLayers[seekCount] = layer;
        seekWeights[seekCount] = layer.weight;
        seekCount++;
        continue;
      }
      seekWeights[seek] += layer.weight;
      if (seekLayers[seek]!.stateId !== command.stateId) seekLayers[seek] = layer;
    }
    // A lone clip keeps the immediate pose write; a crossfade needs Babylon's
    // weighted blend, which only its render-time animation pass computes.
    let blend = seekCount > 1;
    for (let i = 0; blend && i < seekCount; i++) blend = Boolean(seekGroups[i]!.blendToFrame);
    for (let i = 0; i < seekCount; i++) {
      const group = seekGroups[i]!;
      const layer = seekLayers[i]!;
      const span = group.to - group.from;
      if (blend) group.blendToFrame?.(gameplayFrame(group, layer.normalisedTime, span), seekWeights[i]!);
      else seekGameplayAnimation(group, layer.normalisedTime, span, seekWeights[i]!);
    }
  } finally {
    for (let i = 0; i < resolvedCount; i++) {
      resolvedLayers[i] = undefined;
      resolvedGroups[i] = undefined;
    }
    for (let i = 0; i < seekCount; i++) {
      seekLayers[i] = undefined;
      seekGroups[i] = undefined;
    }
  }
  if (spritePrimary) {
    applySpriteLayers(scene, command.slotId, spritePrimary, spriteSecondary);
  }
}

export function sceneAnimHostFromBinding(
  binding: SnapshotSceneBinding,
  options: {
    animationGroups: NamedSeekableGroup[];
    spritePayloads?: ReadonlyMap<string, SpritePayload>;
    spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
    applyTexture?: (mesh: Mesh, textureGuid: string | null | undefined) => void;
    onMissingClip?: (info: MissingAnimClip) => void;
  },
): SceneAnimHost {
  return {
    animationGroups: options.animationGroups,
    getAnimationGroups: (slotId) => binding.slotAnimationGroups?.get(slotId) ?? NO_GROUPS,
    getAnimationGroup: (slotId, clipName, clipAssetGuid) =>
      findClipGroup(
        binding.slotAnimationGroups?.get(slotId) ?? NO_GROUPS,
        clipName,
        clipAssetGuid,
      ),
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

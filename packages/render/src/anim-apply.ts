import { Vector3, type Mesh } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import type { SpriteAnimationPayload, SpritePayload } from "@babylonslate/assets";
import {
  spriteAnimationFrameAt,
  spriteClipFrameAt,
} from "@babylonslate/assets";
import { applySpriteFrameUvs } from "./sprite-quad";
import type { SnapshotSceneBinding } from "./snapshot-apply";

/**
 * Gameplay animation clock lives in the worker. Render only seeks; it never
 * lets Babylon auto-advance a gameplay-relevant clip (engineplan §2.3).
 */
export interface SeekableAnimationGroup {
  pause(): void;
  goToFrame(frame: number): void;
  setWeightForAllAnimatables?(weight: number): void;
}

export function seekGameplayAnimation(
  group: SeekableAnimationGroup,
  normalisedTime: number,
  durationFrames: number,
  weight = 1,
): void {
  group.pause();
  const span = Math.max(0, durationFrames);
  const t = Number.isFinite(normalisedTime)
    ? Math.min(1, Math.max(0, normalisedTime))
    : 0;
  group.goToFrame(t * span);
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
  applySpriteFrameUvs(mesh, {
    name: "sprite-animation",
    u: 0,
    v: 0,
    uSize: 1,
    vSize: 1,
    durationMs: frame.durationMs,
    pivot: frame.pivot,
    width: frame.width,
    height: frame.height,
  });
  options?.applyTexture?.(mesh, frame.textureGuid || null);
  const ppu =
    options?.pixelsPerUnit && options.pixelsPerUnit > 0
      ? options.pixelsPerUnit
      : 100;
  const worldWidth = (frame.width ?? 100) / ppu;
  const worldHeight = (frame.height ?? 100) / ppu;
  mesh.setPivotPoint(
    new Vector3(
      (frame.pivot.x - 0.5) * worldWidth,
      (0.5 - frame.pivot.y) * worldHeight,
      0,
    ),
  );
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
  return scene.animationGroups.find((entry) =>
    groupMatchesClip(entry, layer.clipName, layer.clipAssetGuid),
  );
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
  layers: AnimClipLayer[],
): void {
  const slot = scene.getSpriteSlot?.(slotId);
  if (!slot) {
    const first = layers[0];
    if (first) {
      scene.onMissingClip?.({
        slotId,
        clipName: first.clipName,
        clipAssetGuid: first.clipAssetGuid,
        clipKind: "sprite",
      });
    }
    return;
  }
  const primary = layers[0]!;
  applySpriteLayer(slot, slot.mesh, primary);
  slot.mesh.visibility = primary.weight;
  if (slot.overlayMesh) {
    const secondary = layers[1];
    if (secondary) {
      applySpriteLayer(slot, slot.overlayMesh, secondary);
      slot.overlayMesh.visibility = secondary.weight;
    } else {
      slot.overlayMesh.visibility = 0;
    }
  }
}

/** Seek weighted AnimationGroups, or bake sprite clip UVs (two-layer blend). */
export function applyAnimStateToScene(
  scene: SceneAnimHost,
  command: AnimStateCommand,
): void {
  const layers = animStateLayers(command);
  if (layers.length === 0) return;
  const spriteLayers = layers.filter((layer) => layer.clipKind === "sprite");
  const animationLayers = layers.filter((layer) => layer.clipKind !== "sprite");
  for (const layer of animationLayers) {
    const group = resolveAnimationGroup(scene, command.slotId, layer);
    if (!group) {
      scene.onMissingClip?.({
        slotId: command.slotId,
        clipName: layer.clipName,
        clipAssetGuid: layer.clipAssetGuid,
        clipKind: "animation",
      });
      continue;
    }
    seekGameplayAnimation(
      group,
      layer.normalisedTime,
      group.to - group.from,
      layer.weight,
    );
  }
  if (spriteLayers.length > 0) {
    applySpriteLayers(scene, command.slotId, spriteLayers);
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
    getAnimationGroup: (slotId, clipName, clipAssetGuid) => {
      const groups = binding.slotAnimationGroups?.get(slotId) ?? [];
      return groups.find((group) =>
        groupMatchesClip(group, clipName, clipAssetGuid),
      );
    },
    getSpriteSlot: (slotId) => {
      const slot = resolvePlaySpriteSlot(
        binding,
        options.spritePayloads,
        slotId,
      );
      if (!slot) return undefined;
      return {
        ...slot,
        spriteAnimations:
          options.spriteAnimations ?? binding.spriteAnimations,
        applyTexture: options.applyTexture,
      };
    },
    onMissingClip: options.onMissingClip,
  };
}

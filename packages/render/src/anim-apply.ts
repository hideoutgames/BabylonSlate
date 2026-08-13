import type { Mesh } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import type { SpritePayload } from "@babylonslate/assets";
import { spriteClipFrameAt } from "@babylonslate/assets";
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

export type AnimStateCommand = Extract<CommandMessage, { type: "animState" }>;

export interface SpriteAnimSlot {
  mesh: Mesh;
  payload: SpritePayload;
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
  return { mesh, payload };
}

export interface SceneAnimHost {
  animationGroups: Array<
    SeekableAnimationGroup & { name: string; from: number; to: number }
  >;
  getSpriteSlot?(slotId: number): SpriteAnimSlot | undefined;
}

/** Seek a named AnimationGroup, or bake sprite clip UVs for `clipKind: "sprite"`. */
export function applyAnimStateToScene(
  scene: SceneAnimHost,
  command: AnimStateCommand,
): void {
  if (!command.clipName) return;
  if (command.clipKind === "sprite") {
    const slot = scene.getSpriteSlot?.(command.slotId);
    if (!slot) return;
    applySpriteAnimFrame(
      slot.mesh,
      slot.payload,
      command.clipName,
      command.normalisedTime,
    );
    return;
  }
  const group = scene.animationGroups.find(
    (entry) => entry.name === command.clipName,
  );
  if (!group) return;
  seekGameplayAnimation(
    group,
    command.normalisedTime,
    group.to - group.from,
    command.blendWeights[command.stateId] ?? 1,
  );
}

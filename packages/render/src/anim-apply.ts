import type { Mesh } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import type { SpritePayload } from "@babylonslate/assets";
import { spriteClipFrameAt } from "@babylonslate/assets";
import { applySpriteFrameUvs } from "./sprite-quad";

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

export interface SceneAnimHost {
  animationGroups: Array<
    SeekableAnimationGroup & { name: string; from: number; to: number }
  >;
}

/** Seek a named AnimationGroup. Sprite clip UVs use `applySpriteAnimFrame`. */
export function applyAnimStateToScene(
  scene: SceneAnimHost,
  command: AnimStateCommand,
): void {
  if (!command.clipName || command.clipKind === "sprite") return;
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

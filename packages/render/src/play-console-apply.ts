import type { CommandMessage } from "@babylonslate/bridge";
import type { HardwareScalingController } from "./hardware-scaling";

export const PLAY_QUALITY_SCALE = {
  high: 1,
  medium: 1.5,
  low: 2,
} as const;

export function hardwareScaleForQuality(level: string): number {
  if (level === "medium") return PLAY_QUALITY_SCALE.medium;
  if (level === "low") return PLAY_QUALITY_SCALE.low;
  return PLAY_QUALITY_SCALE.high;
}

export function applyPlayRenderQuality(
  scaling: Pick<HardwareScalingController, "setSettingsLevel" | "getLevel">,
  level: string,
): number {
  const scale = hardwareScaleForQuality(level);
  scaling.setSettingsLevel(scale);
  return scale;
}

export function applyPlayResolutionScale(
  scaling: Pick<HardwareScalingController, "setLevel">,
  scale: number,
): void {
  scaling.setLevel(scale);
}

export type PlayConsoleRenderTarget = {
  scaling: Pick<
    HardwareScalingController,
    "setSettingsLevel" | "setLevel" | "getLevel"
  >;
  scheduler: { setFrameCap: (fps: number) => void };
};

/** Apply Play-only console render commands. Editor viewport scaling is untouched. */
export function applyPlayConsoleRenderCommand(
  target: PlayConsoleRenderTarget,
  command: CommandMessage,
): boolean {
  if (command.type === "setRenderQuality") {
    applyPlayRenderQuality(target.scaling, command.level);
    return true;
  }
  if (command.type === "setResolutionScale") {
    applyPlayResolutionScale(target.scaling, command.scale);
    return true;
  }
  if (command.type === "setFrameCap") {
    target.scheduler.setFrameCap(command.fps);
    return true;
  }
  return false;
}

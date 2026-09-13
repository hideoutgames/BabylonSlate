import type { CommandMessage } from "@babylonslate/bridge";
export type PlayConsoleRenderTarget = { scheduler: { setFrameCap: (fps: number) => void } };
/** Frame caps affect rendering, never the simulation step. */
export function applyPlayConsoleRenderCommand(target: PlayConsoleRenderTarget, command: CommandMessage): boolean {
  if (command.type !== "setFrameCap") return false;
  target.scheduler.setFrameCap(command.fps);
  return true;
}

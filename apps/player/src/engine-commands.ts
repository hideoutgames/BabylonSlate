import type { CommandMessage } from "@babylonslate/bridge";

const ENGINE_COMMAND_TYPES = new Set<CommandMessage["type"]>([
  "assignMesh",
  "assignMaterial",
  "possessCamera",
  "setShadowQuality",
  "animState",
]);

export function applyPlayerEngineCommand(
  handle: { applyCommand: (command: CommandMessage) => void },
  command: { type: string } & Record<string, unknown>,
): boolean {
  if (!ENGINE_COMMAND_TYPES.has(command.type as CommandMessage["type"])) {
    return false;
  }
  handle.applyCommand(command as CommandMessage);
  return true;
}

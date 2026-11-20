import type { CommandMessage } from "@haptic/bridge";

export type PostProcessParameterCommand = Extract<
  CommandMessage,
  { type: "setPostProcessMaterialParameter" }
>;
export interface PostProcessParameterTargets {
  world: { sceneAssetGuid: string | null; sceneLoadId: number; ready: boolean };
  setWorld: (command: PostProcessParameterCommand) => boolean;
  /** The Scene Layer post-processing every layer shares; it checks the pass is still in its stack. */
  setLayers: (command: PostProcessParameterCommand) => boolean;
}

/**
 * Commands captured by a departed or still-loading Scene cannot mutate its replacement. The Scene Layer stack outlives
 * Scenes and layers, so a write to it needs only its pass (the entry and Material the owner checks).
 */
export function applyPostProcessParameterCommand(
  command: PostProcessParameterCommand,
  targets: PostProcessParameterTargets,
): boolean {
  const owner = command.owner;
  if (owner.kind === "sceneLayers") return targets.setLayers(command);
  if (
    !targets.world.ready ||
    targets.world.sceneLoadId !== owner.sceneLoadId ||
    targets.world.sceneAssetGuid !== owner.sceneAssetGuid
  )
    return false;
  return targets.setWorld(command);
}

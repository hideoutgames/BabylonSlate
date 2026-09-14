import type { CommandMessage } from "@babylonslate/bridge";

export type PostProcessParameterCommand = Extract<
  CommandMessage,
  { type: "setPostProcessMaterialParameter" }
>;
export interface PostProcessParameterTargets {
  world: { sceneAssetGuid: string | null; sceneLoadId: number; ready: boolean };
  layer: (id: string) => { loadId: number; ready: boolean } | undefined;
  setWorld: (command: PostProcessParameterCommand) => boolean;
  setLayer: (layerId: string, command: PostProcessParameterCommand) => boolean;
}

/** Commands captured by a departed or still-loading owner cannot mutate its replacement. */
export function applyPostProcessParameterCommand(
  command: PostProcessParameterCommand,
  targets: PostProcessParameterTargets,
): boolean {
  const owner = command.owner;
  if (owner.kind === "scene") {
    if (
      !targets.world.ready ||
      targets.world.sceneLoadId !== owner.sceneLoadId ||
      targets.world.sceneAssetGuid !== owner.sceneAssetGuid
    )
      return false;
    return targets.setWorld(command);
  }
  const layer = targets.layer(owner.layerId);
  if (!layer?.ready || layer.loadId !== owner.layerLoadId) return false;
  return targets.setLayer(owner.layerId, command);
}

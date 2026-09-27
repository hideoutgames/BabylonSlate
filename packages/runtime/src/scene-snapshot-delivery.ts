import type { CommandMessage } from "@babylonslate/bridge";

type SceneRealized = Extract<CommandMessage, { type: "sceneRealized" | "sceneLayerRealized" | "sceneStreamRealized" }>;

/** Hold the batch marker until the transport has sent its complete Actor pose. */
export function createSceneSnapshotDelivery(options: {
  publishSnapshot: () => boolean;
  send: (command: SceneRealized) => void;
}) {
  const pending = new Map<string, SceneRealized>();
  const flush = (): boolean => {
    const commands = [...pending.entries()];
    if (commands.length === 0 || !options.publishSnapshot()) return false;
    let sent = false;
    for (const [key, command] of commands) {
      if (pending.get(key) !== command) continue;
      pending.delete(key);
      options.send(command);
      sent = true;
    }
    return sent;
  };
  return {
    receive(command: CommandMessage): boolean {
      if (command.type === "sceneLoading" || command.type === "activeScene") pending.delete("world");
      if (command.type === "sceneLoading" || command.type === "activeScene") {
        for (const key of pending.keys()) if (key.startsWith("stream:")) pending.delete(key);
      }
      if (command.type === "sceneStreamLoading" || command.type === "sceneStreamRemoved") pending.delete(`stream:${command.actorGuid}`);
      if (command.type === "sceneLayerLoading" || command.type === "sceneLayerRemove") pending.delete(`layer:${command.layerId}`);
      if (command.type === "sceneLayerClear") {
        for (const key of pending.keys()) if (key.startsWith("layer:")) pending.delete(key);
      }
      if (command.type !== "sceneRealized" && command.type !== "sceneLayerRealized" && command.type !== "sceneStreamRealized") return false;
      pending.set(command.type === "sceneRealized" ? "world" : command.type === "sceneStreamRealized" ? `stream:${command.actorGuid}` : `layer:${command.layerId}`, command);
      flush();
      return true;
    },
    flush,
    reset() { pending.clear(); },
  };
}

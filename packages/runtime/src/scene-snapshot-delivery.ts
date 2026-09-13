import type { CommandMessage } from "@babylonslate/bridge";

type SceneRealized = Extract<CommandMessage, { type: "sceneRealized" }>;

/** Hold the batch marker until the transport has sent its complete Actor pose. */
export function createSceneSnapshotDelivery(options: {
  publishSnapshot: () => boolean;
  send: (command: SceneRealized) => void;
}) {
  let pending: SceneRealized | null = null;
  const flush = (): boolean => {
    const command = pending;
    if (!command || !options.publishSnapshot() || pending !== command) return false;
    pending = null;
    options.send(command);
    return true;
  };
  return {
    receive(command: CommandMessage): boolean {
      if (command.type === "activeScene") pending = null;
      if (command.type !== "sceneRealized") return false;
      pending = command;
      flush();
      return true;
    },
    flush,
    reset() { pending = null; },
  };
}

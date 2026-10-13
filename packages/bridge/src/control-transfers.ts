import type { ControlMessage } from "./channels";

/**
 * Buffers a host moves to the worker with this control instead of cloning them.
 * Only buffers the control owns qualify: after the post they are detached on the sender.
 */
export function controlTransferables(message: ControlMessage): ArrayBuffer[] | undefined {
  if (message.type === "loadNavMesh" && message.bytes) return [message.bytes];
  return undefined;
}

import { SeqLockSnapshotPair } from "./seq-lock";
import { TransferablePingPong } from "./transferable";
import type { ControlMessage, CommandMessage } from "./channels";
import { createRpcHost, type RpcTransport } from "./rpc";

export type InProcessBridgeMode = "sab" | "transferable";

export interface InProcessBridge {
  mode: InProcessBridgeMode;
  snapshots: SeqLockSnapshotPair | TransferablePingPong;
  postControl: (message: ControlMessage) => void;
  onCommand: (handler: (message: CommandMessage) => void) => void;
  rpc: ReturnType<typeof createRpcHost>;
}

/**
 * Same channel protocols without a Worker — for harness parity and tests.
 */
export function createInProcessBridge(
  options: { maxActors?: number; mode?: InProcessBridgeMode } = {},
): InProcessBridge {
  const maxActors = options.maxActors ?? 256;
  const preferSab =
    options.mode === "sab" ||
    (options.mode === undefined &&
      typeof SharedArrayBuffer !== "undefined" &&
      typeof Atomics !== "undefined");
  const mode: InProcessBridgeMode = preferSab ? "sab" : "transferable";
  const snapshots =
    mode === "sab"
      ? SeqLockSnapshotPair.create(maxActors)
      : new TransferablePingPong(maxActors);

  const commandHandlers: Array<(message: CommandMessage) => void> = [];
  const controlHandlers: Array<(message: ControlMessage) => void> = [];

  const transport: RpcTransport = {
    post(message) {
      return Promise.resolve({ id: message.id, result: null });
    },
  };

  return {
    mode,
    snapshots,
    postControl: (message) => {
      for (const handler of controlHandlers) handler(message);
    },
    onCommand: (handler) => {
      commandHandlers.push(handler);
    },
    rpc: createRpcHost(transport),
  };
}

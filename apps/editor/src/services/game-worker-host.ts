import type {
  BridgeHostMessage,
  BridgeWorkerMessage,
  CommandMessage,
  ControlMessage,
} from "@babylonslate/bridge";
import { snapshotFloatCount } from "@babylonslate/bridge";
import type { RawInputEvent } from "@babylonslate/input";
import { encodeInputEvents } from "@babylonslate/input";

export interface GameWorkerHost {
  mode: "worker";
  postControl: (message: ControlMessage) => void;
  pushInput: (events: readonly RawInputEvent[]) => void;
  onCommand: (handler: (command: CommandMessage) => void) => void;
  onSnapshot: (handler: (buffer: Float32Array) => void) => void;
  terminate: () => void;
}

/**
 * Spawn the game worker via Vite-resolved module URL. Falls back by throwing
 * so the caller can use createInProcessRuntime.
 */
export function createGameWorkerHost(): GameWorkerHost {
  const worker = new Worker(
    new URL(
      "../../../../packages/runtime/src/worker-entry.ts",
      import.meta.url,
    ),
    { type: "module" },
  );

  const commandHandlers: Array<(command: CommandMessage) => void> = [];
  const snapshotHandlers: Array<(buffer: Float32Array) => void> = [];

  worker.onmessage = (event: MessageEvent<BridgeWorkerMessage>) => {
    const msg = event.data;
    if (msg.channel === "command") {
      for (const handler of commandHandlers) handler(msg.payload);
      return;
    }
    if (msg.channel === "snapshot") {
      const buffer = new Float32Array(msg.payload);
      for (const handler of snapshotHandlers) handler(buffer);
    }
  };

  const post = (message: BridgeHostMessage, transfer?: Transferable[]) => {
    worker.postMessage(message, transfer ?? []);
  };

  return {
    mode: "worker",
    postControl: (message) => post({ channel: "control", payload: message }),
    pushInput: (events) => {
      const buffer = encodeInputEvents(events);
      post({ channel: "input", payload: buffer }, [buffer]);
    },
    onCommand: (handler) => {
      commandHandlers.push(handler);
    },
    onSnapshot: (handler) => {
      snapshotHandlers.push(handler);
    },
    terminate: () => worker.terminate(),
  };
}

export function workerSnapshotScratch(maxActors = 256): Float32Array {
  return new Float32Array(snapshotFloatCount(maxActors));
}

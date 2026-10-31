import {
  controlTransferables,
  dispatchCommandBatch,
  type BridgeHostMessage,
  type BridgeWorkerMessage,
  type CommandMessage,
  type ControlMessage,
} from "@haptic/bridge";
import type { RawInputEvent } from "@haptic/input";
import { encodeInputEvents } from "@haptic/input";
import { PLAY_WORKER_FAILED_CODE } from "./play-session-helpers";

export interface GameWorkerHost {
  postControl: (message: ControlMessage) => void;
  pushInput: (events: readonly RawInputEvent[]) => void;
  onCommand: (handler: (command: CommandMessage) => void) => void;
  onSnapshot: (handler: (buffer: Float32Array) => void) => void;
  terminate: () => void;
}

/**
 * Spawn the game worker via Vite-resolved module URL. Falls back by throwing
 * so the caller can use createInProcessRuntime. A worker that fails later, as a
 * module that cannot load or evaluate does (asynchronously, so `new Worker`
 * succeeded), or that stops unexpectedly, reaches the command handlers as one
 * error diagnostic with `PLAY_WORKER_FAILED_CODE`: nothing else would answer
 * its controls or boundaries.
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
  let installedGeneration = 0;
  let terminated = false;

  const post = (message: BridgeHostMessage, transfer?: Transferable[]) => {
    worker.postMessage(message, transfer ?? []);
  };

  const dispatchCommand = (command: CommandMessage) => {
    if (command.type === "snapshotLayout") {
      installedGeneration = command.generation;
      post({ channel: "snapshotLayoutAck", generation: installedGeneration });
    }
    for (const handler of commandHandlers) handler(command);
  };

  let failed = false;
  const reportFailure = (message: string) => {
    if (terminated || failed) return;
    failed = true;
    dispatchCommand({ type: "diagnostic", code: PLAY_WORKER_FAILED_CODE, severity: "error", frameId: 0, message });
  };
  worker.onerror = (event: ErrorEvent) => {
    // WebKit reports a worker that failed to load or crashed without a message; keep where it was.
    const at = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    reportFailure(event.message ? `The game worker failed: ${event.message}${at}` : `The game worker failed to start or stopped unexpectedly${at}.`);
  };
  worker.onmessageerror = () => reportFailure("The game worker sent an unreadable message.");

  worker.onmessage = (event: MessageEvent<BridgeWorkerMessage>) => {
    const msg = event.data;
    if (msg.channel === "command") {
      dispatchCommand(msg.payload);
      return;
    }
    if (msg.channel === "commands") {
      dispatchCommandBatch(msg.payload, dispatchCommand, () => terminated);
      return;
    }
    if (msg.channel === "snapshot") {
      const ab = msg.payload;
      if (msg.generation !== installedGeneration) {
        post({ channel: "recycleSnapshot", payload: ab }, [ab]);
        return;
      }
      const buffer = new Float32Array(ab);
      // Consumers (SnapshotSampler.push) copy synchronously, so the
      // buffer is safe to hand straight back for the worker's next frame —
      // avoids a fresh ArrayBuffer allocation every tick. The worker caps
      // unreturned snapshots, so a throwing consumer must still return it.
      try {
        for (const handler of snapshotHandlers) handler(buffer);
      } finally {
        post({ channel: "recycleSnapshot", payload: ab }, [ab]);
      }
    }
  };

  return {
    postControl: (message) => post({ channel: "control", payload: message }, controlTransferables(message)),
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
    terminate: () => {
      terminated = true;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    },
  };
}

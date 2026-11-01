import {
  dispatchCommandBatch,
  type BridgeHostMessage,
  type BridgeWorkerMessage,
  type CommandMessage,
  type ControlMessage,
} from "@haptic/bridge";
import { encodeInputEvents } from "@haptic/input";
import type { RawInputEvent } from "@haptic/input";

export type PlayerWorkerHost = {
  postControl: (message: ControlMessage) => void;
  pushInput: (events: readonly RawInputEvent[]) => void;
  onCommand: (handler: (command: CommandMessage) => void) => void;
  onSnapshot: (handler: (buffer: Float32Array) => void) => void;
  onError: (handler: (error: Error) => void) => void;
  terminate: () => void;
};

export function createPlayerWorkerHost(): PlayerWorkerHost {
  const worker = new Worker(
    new URL("@haptic/runtime/worker-entry", import.meta.url),
    { type: "module" },
  );
  const commandHandlers: Array<(command: CommandMessage) => void> = [];
  const snapshotHandlers: Array<(buffer: Float32Array) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  let installedGeneration = 0;
  let stopped = false;
  // A worker whose module never evaluates posts nothing and may raise no error: report it after the boundary timeout.
  let started = false;
  const startTimer = setTimeout(() => {
    if (!started) reportError(new Error("The game worker did not start within 10 seconds: its module never finished loading."));
  }, 10_000);
  const post = (message: BridgeHostMessage, transfer?: Transferable[]) => {
    worker.postMessage(message, transfer ?? []);
  };
  const reportError = (error: Error) => {
    if (stopped) return;
    // One cause per worker: an error before the start timeout already said why it never started.
    clearTimeout(startTimer);
    for (const handler of [...errorHandlers]) handler(error);
  };
  worker.onerror = (event) => {
    // WebKit reports a worker that failed to load or crashed without a message; keep where it was.
    const at = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    reportError(new Error(event.message ? `${event.message}${at}` : `The game worker failed to start or stopped unexpectedly${at}.`));
  };
  worker.onmessageerror = () => reportError(new Error("The game worker sent an unreadable message."));
  const dispatchCommand = (command: CommandMessage) => {
    if (command.type === "snapshotLayout") {
      installedGeneration = command.generation;
      post({ channel: "snapshotLayoutAck", generation: installedGeneration });
    }
    for (const handler of commandHandlers) handler(command);
  };
  worker.onmessage = (event: MessageEvent<BridgeWorkerMessage>) => {
    if (stopped) return;
    const msg = event.data;
    if (msg.channel === "ready") {
      started = true;
      clearTimeout(startTimer);
      return;
    }
    if (msg.channel === "command") {
      dispatchCommand(msg.payload);
      return;
    }
    if (msg.channel === "commands") {
      dispatchCommandBatch(msg.payload, dispatchCommand, () => stopped);
      return;
    }
    if (msg.channel === "snapshot") {
      const ab = msg.payload;
      if (msg.generation !== installedGeneration) {
        post({ channel: "recycleSnapshot", payload: ab }, [ab]);
        return;
      }
      const buffer = new Float32Array(ab);
      // The worker caps unreturned snapshots, so a throwing consumer must still return it.
      try {
        for (const handler of snapshotHandlers) handler(buffer);
      } finally {
        post({ channel: "recycleSnapshot", payload: ab }, [ab]);
      }
    }
  };
  return {
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
    onError: (handler) => {
      errorHandlers.push(handler);
    },
    terminate: () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(startTimer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      commandHandlers.length = 0;
      snapshotHandlers.length = 0;
      errorHandlers.length = 0;
      worker.terminate();
    },
  };
}

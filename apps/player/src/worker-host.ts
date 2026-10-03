import type {
  BridgeHostMessage,
  BridgeWorkerMessage,
  CommandMessage,
  ControlMessage,
} from "@babylonslate/bridge";
import { encodeInputEvents } from "@babylonslate/input";
import type { RawInputEvent } from "@babylonslate/input";

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
    new URL("@babylonslate/runtime/worker-entry", import.meta.url),
    { type: "module" },
  );
  const commandHandlers: Array<(command: CommandMessage) => void> = [];
  const snapshotHandlers: Array<(buffer: Float32Array) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  let installedGeneration = 0;
  let stopped = false;
  const post = (message: BridgeHostMessage, transfer?: Transferable[]) => {
    worker.postMessage(message, transfer ?? []);
  };
  const reportError = (error: Error) => {
    if (stopped) return;
    for (const handler of [...errorHandlers]) handler(error);
  };
  worker.onerror = (event) => {
    reportError(new Error(event.message || "The game worker failed to start or stopped unexpectedly."));
  };
  worker.onmessageerror = () => reportError(new Error("The game worker sent an unreadable message."));
  worker.onmessage = (event: MessageEvent<BridgeWorkerMessage>) => {
    if (stopped) return;
    const msg = event.data;
    if (msg.channel === "command") {
      if (msg.payload.type === "snapshotLayout") {
        installedGeneration = msg.payload.generation;
        post({ channel: "snapshotLayoutAck", generation: installedGeneration });
      }
      for (const handler of commandHandlers) handler(msg.payload);
      return;
    }
    if (msg.channel === "snapshot") {
      const ab = msg.payload;
      if (msg.generation !== installedGeneration) {
        post({ channel: "recycleSnapshot", payload: ab }, [ab]);
        return;
      }
      const buffer = new Float32Array(ab);
      for (const handler of snapshotHandlers) handler(buffer);
      post({ channel: "recycleSnapshot", payload: ab }, [ab]);
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

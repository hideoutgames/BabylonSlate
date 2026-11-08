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
  /** Whether the worker has reported an error, with or without a handler attached: a prewarmed host is then replaced. */
  failed: () => boolean;
  terminate: () => void;
};

/** The physics engine wasm the worker loads for 3D games. */
export function playerHavokWasmUrl(): string {
  return new URL("./havok/HavokPhysics.wasm", document.baseURI).href;
}

/**
 * Start the game worker when a launch begins, before its download, so the worker module loads and
 * evaluates meanwhile. The boot adopts it (`PlayerBootOptions.worker`) unless it failed; the
 * launch terminates it when it stops or fails before then. Undefined when this host cannot start a
 * module worker: the boot then falls back as before.
 */
export function prewarmPlayerWorker(): PlayerWorkerHost | undefined {
  try { return createPlayerWorkerHost(); } catch { return undefined; }
}

/** Have a prewarmed worker compile the physics engine the game's `physicsWorld` runs on while the download continues. */
export function preloadPlayerWorkerPhysics(worker: PlayerWorkerHost | undefined, physicsWorld: "3d" | "2d"): void {
  if (!worker || worker.failed()) return;
  worker.postControl({ type: "preloadPhysics", physicsWorld, havokWasmUrl: playerHavokWasmUrl() });
}

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
  let failed = false;
  // A worker whose module never evaluates posts nothing and may raise no error: report it after the boundary timeout.
  // The wait starts with the first error handler, so a worker prewarmed during the download gets the
  // whole timeout once the boot adopts it.
  let started = false;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const armStartTimer = () => {
    if (started || failed || stopped || startTimer !== undefined) return;
    startTimer = setTimeout(() => {
      if (!started) reportError(new Error("The game worker did not start within 10 seconds: its module never finished loading."));
    }, 10_000);
  };
  const post = (message: BridgeHostMessage, transfer?: Transferable[]) => {
    worker.postMessage(message, transfer ?? []);
  };
  const reportError = (error: Error) => {
    if (stopped) return;
    failed = true;
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
      armStartTimer();
    },
    failed: () => failed,
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

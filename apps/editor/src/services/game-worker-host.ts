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

export interface GameWorkerHost {
  postControl: (message: ControlMessage) => void;
  pushInput: (events: readonly RawInputEvent[]) => void;
  onCommand: (handler: (command: CommandMessage) => void) => void;
  onSnapshot: (handler: (buffer: Float32Array) => void) => void;
  /** The worker cannot run: it failed to load or evaluate, never started, or cannot read a message. Reported once. */
  onFailure: (handler: (message: string) => void) => void;
  terminate: () => void;
}

/** How long a worker may take to evaluate its module: the session boundary timeout, which a live worker answers well within. */
export const GAME_WORKER_START_TIMEOUT_MS = 10_000;

/** A worker error event as the host Worker reports it: where the module failed to load or evaluate. */
function describeWorkerError(event: ErrorEvent): string {
  const where = event.filename ? ` (${event.filename}${event.lineno ? `:${event.lineno}${event.colno ? `:${event.colno}` : ""}` : ""})` : "";
  return `The Play worker failed to start: ${event.message || "its module could not be loaded"}${where}`;
}

/** The next session's worker, started during Play preparation. */
let prewarmed: { host: GameWorkerHost; failed: boolean; physics: Set<string> } | null = null;

/**
 * Start the next session's game worker while Play prepares its content, so the
 * worker module loads and evaluates meanwhile and {@link preloadPrewarmedGameWorkerPhysics}
 * can compile its physics engine. The next {@link createGameWorkerHost} takes it;
 * if `signal` ends first (the session was cancelled or failed), it is terminated.
 */
export function prewarmGameWorker(signal: AbortSignal): void {
  if (prewarmed || signal.aborted) return;
  let host: GameWorkerHost;
  // A host without module workers falls back in-process when the session starts.
  try { host = spawnGameWorkerHost(); } catch { return; }
  const entry = { host, failed: false, physics: new Set<string>() };
  host.onFailure(() => { entry.failed = true; });
  prewarmed = entry;
  signal.addEventListener("abort", () => {
    if (prewarmed !== entry) return;
    prewarmed = null;
    host.terminate();
  }, { once: true });
}

/** Have the prewarmed worker, if any, load the physics engine a `physicsWorld` Scene runs on. */
export function preloadPrewarmedGameWorkerPhysics(physicsWorld: "3d" | "2d", havokWasmUrl: string): void {
  const entry = prewarmed;
  if (!entry || entry.failed || entry.physics.has(physicsWorld)) return;
  entry.physics.add(physicsWorld);
  entry.host.postControl({ type: "preloadPhysics", physicsWorld, havokWasmUrl });
}

/**
 * The session's game worker: the prewarmed one when it is still healthy,
 * otherwise a new one. Falls back by throwing so the caller can use
 * createInProcessRuntime.
 */
export function createGameWorkerHost(): GameWorkerHost {
  const entry = prewarmed;
  prewarmed = null;
  if (entry && !entry.failed) return entry.host;
  entry?.host.terminate();
  return spawnGameWorkerHost();
}

/** Spawn the game worker via Vite-resolved module URL. */
function spawnGameWorkerHost(): GameWorkerHost {
  const worker = new Worker(
    new URL(
      "../../../../packages/runtime/src/worker-entry.ts",
      import.meta.url,
    ),
    { type: "module" },
  );

  const commandHandlers: Array<(command: CommandMessage) => void> = [];
  const snapshotHandlers: Array<(buffer: Float32Array) => void> = [];
  const failureHandlers: Array<(message: string) => void> = [];
  let installedGeneration = 0;
  let terminated = false;
  let started = false;
  let failure: string | null = null;
  const fail = (message: string) => {
    if (terminated || failure !== null) return;
    failure = message;
    clearTimeout(startTimer);
    for (const handler of failureHandlers) handler(message);
  };
  // A module worker that fails to fetch, parse or evaluate reports it only here: its own handlers never installed.
  // Once started, the worker reports its own uncaught errors as runtime diagnostics, and Play goes on.
  worker.onerror = (event: ErrorEvent) => {
    if (started) return;
    event.preventDefault?.();
    fail(describeWorkerError(event));
  };
  worker.onmessageerror = () => fail("The Play worker could not read a message from the game runtime.");
  const startTimer = setTimeout(() => {
    if (!started) fail(`The Play worker did not start within ${GAME_WORKER_START_TIMEOUT_MS / 1000} seconds: its module never finished loading.`);
  }, GAME_WORKER_START_TIMEOUT_MS);

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

  worker.onmessage = (event: MessageEvent<BridgeWorkerMessage>) => {
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
    onFailure: (handler) => {
      failureHandlers.push(handler);
      if (failure !== null) handler(failure);
    },
    terminate: () => {
      terminated = true;
      clearTimeout(startTimer);
      worker.terminate();
    },
  };
}

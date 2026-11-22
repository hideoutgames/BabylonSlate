import { createOpfsFileOps, navigatorOpfsRoot, OPFS_MUTATIONS, OpfsFailure, type OpfsFileOps } from "./opfs-file-ops";
import type { OpfsOperation, OpfsPing, OpfsReply, OpfsRequest } from "./opfs-worker-protocol";

/** How long the storage worker may take to evaluate before file operations stay on the main thread. */
const READY_TIMEOUT_MS = 10_000;
/**
 * While requests are in flight the client pings the worker this often. The
 * worker answers between its awaits (OPFS calls, and every staged-write chunk),
 * so a pong takes milliseconds even during a long write; a slow write is never
 * taken for a dead worker.
 */
const PING_INTERVAL_MS = 5_000;
/**
 * Intervals a ping may stay unanswered (10 s) before the worker counts as dead:
 * room for a long GC pause or a busy main thread, while storage still recovers
 * well before a person gives up on a save.
 */
const PONG_DEADLINE_INTERVALS = 2;

/** The part of `Worker` the client uses; tests drive it with an in-memory double. */
export interface OpfsWorkerLike {
  onmessage: ((event: { data: OpfsReply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: OpfsRequest | OpfsPing, transfer: Transferable[]): void;
  terminate(): void;
}

interface Pending {
  op: OpfsOperation;
  args: unknown[];
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

type Operation = (...args: unknown[]) => Promise<unknown>;

/**
 * File operations run by one storage worker, so OPFS calls no longer queue
 * behind the render loop. Requests wait until the worker has evaluated
 * (`ready`); if it never gets there, they and every later call run on the
 * main thread instead. If it fails afterwards, in-flight reads run again on
 * the main thread, but an in-flight mutation rejects as `interrupted`: it may
 * or may not have happened, so it is never repeated. A worker that dies
 * silently (no error event) is found by pinging it while requests are in
 * flight; no timer is armed while nothing is.
 */
export function createOpfsWorkerClient(spawn: () => OpfsWorkerLike, mainThread: () => OpfsFileOps): OpfsFileOps {
  let state: "idle" | "starting" | "ready" | "disabled" = "idle";
  let worker: OpfsWorkerLike | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  /** Intervals since the outstanding ping was sent, or null when none is. */
  let unanswered: number | null = null;
  let nextId = 1;
  const waiting: Pending[] = [];
  const inFlight = new Map<number, Pending>();
  let local: OpfsFileOps | undefined;

  const runLocally = (pending: Pending) => {
    const ops = local ??= mainThread();
    (ops[pending.op] as Operation)(...pending.args).then(pending.resolve, pending.reject);
  };

  function disable(reason: string): void {
    if (state === "disabled") return;
    state = "disabled";
    clearTimeout(readyTimer);
    stopHeartbeat();
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Already gone. */ }
      worker = null;
    }
    console.warn(`The storage worker is unavailable (${reason}); file operations run on the main thread.`);
    for (const pending of waiting.splice(0)) runLocally(pending);
    const interrupted = [...inFlight.values()];
    inFlight.clear();
    for (const pending of interrupted) {
      if (OPFS_MUTATIONS.has(pending.op)) pending.reject(interruption(pending));
      else runLocally(pending);
    }
  }

  function start(): void {
    state = "starting";
    let spawned: OpfsWorkerLike;
    try {
      spawned = spawn();
    } catch (error) {
      disable(String(error));
      return;
    }
    worker = spawned;
    spawned.onmessage = (event) => receive(event.data);
    spawned.onerror = (event) => disable(event?.message || "the worker failed");
    spawned.onmessageerror = () => disable("a reply could not be read");
    readyTimer = setTimeout(() => disable("the worker did not start"), READY_TIMEOUT_MS);
  }

  function stopHeartbeat(): void {
    clearTimeout(heartbeat);
    heartbeat = undefined;
    unanswered = null;
  }

  function beat(): void {
    heartbeat = undefined;
    if (state !== "ready" || inFlight.size === 0) {
      unanswered = null;
      return;
    }
    if (unanswered === null) {
      unanswered = 0;
      worker!.postMessage({ type: "ping" }, []);
    } else if (++unanswered >= PONG_DEADLINE_INTERVALS) {
      disable("it stopped answering");
      return;
    }
    heartbeat = setTimeout(beat, PING_INTERVAL_MS);
  }

  function receive(reply: OpfsReply): void {
    if ("type" in reply && reply.type === "pong") {
      unanswered = null;
      return;
    }
    if ("type" in reply) {
      if (state !== "starting") return;
      state = "ready";
      clearTimeout(readyTimer);
      for (const pending of waiting.splice(0)) send(pending);
      return;
    }
    const pending = inFlight.get(reply.id);
    if (!pending) return;
    inFlight.delete(reply.id);
    if (inFlight.size === 0) stopHeartbeat();
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(new OpfsFailure(reply.failure));
  }

  function send(pending: Pending): void {
    const id = nextId++;
    inFlight.set(id, pending);
    heartbeat ??= setTimeout(beat, PING_INTERVAL_MS);
    const bytes = pending.op === "writeBinary" ? pending.args[2] as Uint8Array : undefined;
    try {
      worker!.postMessage({ id, op: pending.op, args: pending.args }, bytes ? [bytes.buffer as ArrayBuffer] : []);
    } catch {
      // Nothing reached the worker, so the operation has not started.
      inFlight.delete(id);
      if (inFlight.size === 0) stopHeartbeat();
      runLocally(pending);
    }
  }

  function call<T>(op: OpfsOperation, args: unknown[]): Promise<T> {
    if (state === "disabled") return ((local ??= mainThread())[op] as Operation)(...args) as Promise<T>;
    // Bytes bound for the worker are copied, so transferring them leaves the caller's buffer (or
    // the larger one its view is into) usable; not `slice()`, which a `Buffer` subclass answers
    // with a view. The copy is taken now, so a write waiting for `ready` sends the bytes as they
    // were when it was called.
    if (op === "writeBinary") args = [args[0], args[1], new Uint8Array(args[2] as Uint8Array)];
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { op, args, resolve: resolve as (value: unknown) => void, reject };
      if (state === "ready") {
        send(pending);
        return;
      }
      waiting.push(pending);
      if (state === "idle") start();
    });
  }

  return {
    ensureProjectDir: (dirName) => call("ensureProjectDir", [dirName]),
    removeProjectDir: (dirName) => call("removeProjectDir", [dirName]),
    readBinary: (dirName, path) => call("readBinary", [dirName, path]),
    readRange: (dirName, path, offset, length, counter, expectedRevision) =>
      call("readRange", [dirName, path, offset, length, counter, expectedRevision]),
    writeBinary: (dirName, path, data) => call("writeBinary", [dirName, path, data]),
    stat: (dirName, path) => call("stat", [dirName, path]),
    exists: (dirName, path) => call("exists", [dirName, path]),
    readdir: (dirName, path) => call("readdir", [dirName, path]),
    mkdir: (dirName, path, recursive) => call("mkdir", [dirName, path, recursive]),
    remove: (dirName, path) => call("remove", [dirName, path]),
  };
}

const INTERRUPTED_WORK: Partial<Record<OpfsOperation, string>> = {
  writeBinary: "writing",
  mkdir: "creating the folder",
  remove: "removing",
  ensureProjectDir: "opening the project folder",
  removeProjectDir: "deleting the project folder",
};

function interruption(pending: Pending): OpfsFailure {
  const path = pending.op === "ensureProjectDir" || pending.op === "removeProjectDir" ? "" : String(pending.args[1] ?? "");
  const work = INTERRUPTED_WORK[pending.op] ?? pending.op;
  return new OpfsFailure({
    kind: "interrupted",
    path,
    message: `Storage stopped while ${work}${path ? ` ${path}` : ""}; the change may or may not have been made`,
  });
}

/**
 * A storage worker needs module workers and OPFS, and only a window spawns
 * one: code already in a worker (where `Worker` exists too) runs the
 * operations directly instead of adding a hop through a nested worker that
 * the build would also have to bundle. Native shells and Electron project
 * storage never construct an OPFS adapter.
 */
export function opfsWorkerSupported(): boolean {
  return typeof document !== "undefined" && typeof Worker === "function" &&
    typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

let shared: OpfsFileOps | undefined;

/** The realm's storage worker client, shared by every OPFS adapter; the worker starts on the first call. */
export function sharedOpfsWorkerOps(): OpfsFileOps {
  return shared ??= createOpfsWorkerClient(
    () => new Worker(new URL("./opfs-storage.worker.ts", import.meta.url), { type: "module" }) as unknown as OpfsWorkerLike,
    () => createOpfsFileOps(navigatorOpfsRoot()),
  );
}

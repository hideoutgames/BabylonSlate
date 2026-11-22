import { createOpfsFileOps, navigatorOpfsRoot, OPFS_MUTATIONS, OpfsFailure, type OpfsFileOps } from "./opfs-file-ops";
import type { OpfsOperation, OpfsReply, OpfsRequest } from "./opfs-worker-protocol";

/** How long the storage worker may take to evaluate before file operations stay on the main thread. */
const READY_TIMEOUT_MS = 10_000;

/** The part of `Worker` the client uses; tests drive it with an in-memory double. */
export interface OpfsWorkerLike {
  onmessage: ((event: { data: OpfsReply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: OpfsRequest, transfer: Transferable[]): void;
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
 * or may not have happened, so it is never repeated.
 */
export function createOpfsWorkerClient(spawn: () => OpfsWorkerLike, mainThread: () => OpfsFileOps): OpfsFileOps {
  let state: "idle" | "starting" | "ready" | "disabled" = "idle";
  let worker: OpfsWorkerLike | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
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

  function receive(reply: OpfsReply): void {
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
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(new OpfsFailure(reply.failure));
  }

  function send(pending: Pending): void {
    const id = nextId++;
    inFlight.set(id, pending);
    const bytes = pending.op === "writeBinary" ? pending.args[2] as Uint8Array : undefined;
    try {
      worker!.postMessage({ id, op: pending.op, args: pending.args }, bytes ? [bytes.buffer as ArrayBuffer] : []);
    } catch {
      // Nothing reached the worker, so the operation has not started.
      inFlight.delete(id);
      runLocally(pending);
    }
  }

  function call<T>(op: OpfsOperation, args: unknown[]): Promise<T> {
    if (state === "disabled") return ((local ??= mainThread())[op] as Operation)(...args) as Promise<T>;
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
    // The worker receives its own copy, so the caller's buffer (or the larger one its view is
    // into) stays usable. Not `slice()`: a `Buffer` subclass returns a view from it.
    writeBinary: (dirName, path, data) => call("writeBinary", [dirName, path, new Uint8Array(data)]),
    stat: (dirName, path) => call("stat", [dirName, path]),
    exists: (dirName, path) => call("exists", [dirName, path]),
    readdir: (dirName, path) => call("readdir", [dirName, path]),
    mkdir: (dirName, path, recursive) => call("mkdir", [dirName, path, recursive]),
    remove: (dirName, path) => call("remove", [dirName, path]),
  };
}

function interruption(pending: Pending): OpfsFailure {
  const path = typeof pending.args[1] === "string" ? pending.args[1] : "";
  const target = path ? `${pending.op} ${path}` : pending.op;
  return new OpfsFailure({
    kind: "interrupted",
    path,
    message: `Storage stopped during ${target}; it may or may not have completed`,
  });
}

/** A storage worker needs module workers and OPFS; native shells and Electron project storage never construct an OPFS adapter. */
export function opfsWorkerSupported(): boolean {
  return typeof Worker === "function" && typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function";
}

let shared: OpfsFileOps | undefined;

/** The realm's storage worker client, shared by every OPFS adapter; the worker starts on the first call. */
export function sharedOpfsWorkerOps(): OpfsFileOps {
  return shared ??= createOpfsWorkerClient(
    () => new Worker(new URL("./opfs-storage.worker.ts", import.meta.url), { type: "module" }) as unknown as OpfsWorkerLike,
    () => createOpfsFileOps(navigatorOpfsRoot()),
  );
}

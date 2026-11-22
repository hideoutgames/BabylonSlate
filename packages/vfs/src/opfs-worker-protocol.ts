import { OPFS_OPERATIONS, OpfsFailure, type OpfsFailureData, type OpfsFileOps } from "./opfs-file-ops";

/** Messages between `OpfsWorkerClient` and the storage worker. */
export type OpfsOperation = keyof OpfsFileOps;

export interface OpfsRequest {
  id: number;
  op: OpfsOperation;
  args: unknown[];
}

/** A liveness check; the worker answers `pong` at once, even while operations are awaiting I/O. */
export interface OpfsPing {
  type: "ping";
}

export type OpfsReply =
  | { type: "ready" }
  | { type: "pong" }
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; failure: OpfsFailureData };

/** The worker's side of the channel (`self` in the worker, an in-memory double in tests). */
export interface OpfsWorkerEndpoint {
  onmessage: ((event: { data: OpfsRequest | OpfsPing }) => void) | null;
  postMessage(message: OpfsReply, transfer?: Transferable[]): void;
}

/** Byte buffers in a result, which move to the caller instead of being copied. */
export function resultTransfer(value: unknown): Transferable[] {
  const bytes = value instanceof Uint8Array ? value : (value as { bytes?: unknown } | null)?.bytes;
  return bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
}

/**
 * Answer requests with `ops`, each as it arrives (they run concurrently, as
 * the main thread's calls did), after announcing that the script evaluated.
 */
export function serveOpfsFileOps(endpoint: OpfsWorkerEndpoint, ops: OpfsFileOps): void {
  endpoint.onmessage = (event) => {
    const message = event.data;
    if ("type" in message) endpoint.postMessage({ type: "pong" });
    else void answer(endpoint, ops, message);
  };
  endpoint.postMessage({ type: "ready" });
}

async function answer(endpoint: OpfsWorkerEndpoint, ops: OpfsFileOps, request: OpfsRequest): Promise<void> {
  const { id, op, args } = request;
  let reply: OpfsReply;
  let transfer: Transferable[] = [];
  try {
    if (!OPFS_OPERATIONS.has(op)) throw new Error(`Unknown storage operation: ${String(op)}`);
    const value = await (ops[op] as (...values: unknown[]) => Promise<unknown>)(...args);
    reply = { id, ok: true, value };
    transfer = resultTransfer(value);
  } catch (error) {
    reply = { id, ok: false, failure: failureData(error) };
  }
  try {
    endpoint.postMessage(reply, transfer);
  } catch (error) {
    endpoint.postMessage({ id, ok: false, failure: failureData(error) });
  }
}

function failureData(error: unknown): OpfsFailureData {
  if (error instanceof OpfsFailure) return error.toData();
  return new OpfsFailure({ kind: "error", path: "", message: String((error as { message?: unknown } | null)?.message ?? error) }, error).toData();
}

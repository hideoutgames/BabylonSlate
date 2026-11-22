import type { OpfsFileOps } from "../opfs-file-ops";
import type { OpfsWorkerLike } from "../opfs-worker-client";
import { serveOpfsFileOps, type OpfsReply, type OpfsRequest, type OpfsWorkerEndpoint } from "../opfs-worker-protocol";

export interface MemoryOpfsWorker extends OpfsWorkerLike {
  /** Requests the worker has received. */
  readonly received: OpfsRequest[];
  /** Fail the worker as a script error or crash would. */
  crash(message?: string): void;
}

/**
 * A storage worker in the same realm: messages cross with structured cloning
 * and transfers (so a transferred buffer is detached, as in a browser) in
 * later tasks. With `start: false` it never reports `ready`.
 */
export function createMemoryOpfsWorker(ops: OpfsFileOps, options: { start?: boolean } = {}): MemoryOpfsWorker {
  let terminated = false;
  const later = (deliver: () => void) => setTimeout(() => { if (!terminated) deliver(); }, 0);
  const endpoint: OpfsWorkerEndpoint = {
    onmessage: null,
    postMessage(message: OpfsReply, transfer: Transferable[] = []) {
      const data = structuredClone(message, { transfer });
      later(() => worker.onmessage?.({ data }));
    },
  };
  const worker: MemoryOpfsWorker = {
    received: [],
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message: OpfsRequest, transfer: Transferable[]) {
      const data = structuredClone(message, { transfer });
      later(() => {
        worker.received.push(data);
        endpoint.onmessage?.({ data });
      });
    },
    terminate() { terminated = true; },
    crash(message = "worker crashed") {
      if (!terminated) worker.onerror?.({ message });
    },
  };
  if (options.start !== false) serveOpfsFileOps(endpoint, ops);
  return worker;
}

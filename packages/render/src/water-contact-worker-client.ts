import type { ContactRasterJob } from "./water-contact-raster";
import type { WaterContactWorkerReply, WaterContactWorkerRequest } from "./water-contact.worker";

/**
 * Where contact windows are built off the main thread: `post` sends one job and resolves with its write window's
 * texels (`rasterContactWindow`'s `out`), in the order jobs were posted; `close` stops it, rejecting what is pending.
 */
export type ContactRasterTransport = {
  post(job: ContactRasterJob): Promise<Uint8Array>;
  close(): void;
};

/** A job not answered within this long counts as a failed worker. */
export const WATER_CONTACT_WORKER_TIMEOUT_MS = 10_000;

/**
 * Builds contact windows through a transport opened on first use. The first failure (an error, an unreadable reply,
 * a timeout, or a transport that cannot open) disables it for the rest of the session with one warning: every job
 * then pending rejects, and callers build their windows on the main thread instead.
 */
export class ContactRasterClient {
  private transport: ContactRasterTransport | null = null;
  private failed = false;
  private readonly open: () => ContactRasterTransport;

  constructor(open: () => ContactRasterTransport) {
    this.open = open;
  }

  /** False once a failure disabled it. */
  get available(): boolean { return !this.failed; }

  /** The job's texels; rejects when the client is or becomes disabled. Structured cloning leaves `job` intact. */
  run(job: ContactRasterJob): Promise<Uint8Array> {
    if (this.failed) return Promise.reject(new Error("The water contact worker is disabled."));
    let transport: ContactRasterTransport;
    try {
      transport = this.transport ??= this.open();
    } catch (error) {
      this.fail(error);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return transport.post(job).catch((error: unknown) => {
      this.fail(error);
      throw error instanceof Error ? error : new Error(String(error));
    });
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    console.warn(`[render] Water contact worker failed; building contacts on the main thread: ${error instanceof Error ? error.message : String(error)}`);
    const transport = this.transport;
    this.transport = null;
    transport?.close();
  }
}

/** A module worker running `water-contact.worker.ts`; jobs answer in order, each within the timeout. */
function workerTransport(): ContactRasterTransport {
  const worker = new Worker(new URL("./water-contact.worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (texels: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 0, closed = false;
  const failAll = (error: Error) => {
    if (closed) return;
    closed = true;
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<WaterContactWorkerReply>) => {
    const reply = event.data, job = pending.get(reply.id);
    if (!job) return;
    pending.delete(reply.id);
    clearTimeout(job.timer);
    if (!("error" in reply)) { job.resolve(reply.texels); return; }
    // A job that failed fails the worker, and every job still pending with it.
    const error = new Error(reply.error);
    job.reject(error);
    failAll(error);
  };
  worker.onerror = (event) => { event.preventDefault(); failAll(new Error(event.message || "worker failed")); };
  worker.onmessageerror = () => failAll(new Error("unreadable worker reply"));
  return {
    post(job) {
      if (closed) return Promise.reject(new Error("The water contact worker stopped."));
      const id = next++;
      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => failAll(new Error("timed out")), WATER_CONTACT_WORKER_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          // Structured cloning copies the pieces' arrays; the caller keeps using its own.
          worker.postMessage({ id, job } satisfies WaterContactWorkerRequest);
        } catch (error) {
          failAll(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close: () => failAll(new Error("The water contact worker stopped.")),
  };
}

let shared: ContactRasterClient | null = null;

/**
 * The realm's one contact worker client, shared by every field and Scene; its worker starts with the first job. Null
 * where workers do not exist.
 */
export function sharedContactRaster(): ContactRasterClient | null {
  if (typeof Worker === "undefined") return null;
  return shared ??= new ContactRasterClient(workerTransport);
}

import type { WaterContactJobMessage, WaterContactWorkerReply, WaterContactWorkerRequest } from "./water-contact-jobs";

/** What a contact field hears back from its worker. */
export interface WaterContactWorkerClient {
  /** A result or error for a job this field posted. */
  reply(reply: WaterContactWorkerReply): void;
  /** The off-thread path is gone (a worker failed, hung or could not start): rebuild on the main thread from now on. */
  fail(): void;
}

/** A field's place on one contact worker, which keeps the field's pieces between jobs. */
export interface WaterContactWorkerLink {
  readonly field: number;
  post(message: WaterContactJobMessage, transfer: Transferable[]): void;
  /** Gives up the off-thread path for every field: each falls back to the main thread. */
  fail(reason: string): void;
  /** The field is disposed: its worker drops its pieces, and exits once it serves no field. Idempotent. */
  detach(): void;
}

/**
 * At most this many contact workers, fewer on small devices (`workerLimit`). Fields stay on the worker they joined,
 * which keeps their pieces; a new field joins the least loaded one.
 */
const MAX_CONTACT_WORKERS = 2;
type Member = { client: WaterContactWorkerClient; weight: number };
type Slot = { worker: Worker; members: Map<number, Member>; weight: number };
const slots: Slot[] = [];
let fieldIds = 0;
/** Links not yet detached, including fields that fell back; a failure lasts until none remain (a scene switch). */
let links = 0;
let failed = false;

function workerLimit(): number {
  const cores = typeof navigator === "undefined" ? 0 : navigator.hardwareConcurrency || 0;
  // The main thread and the game worker keep a core each.
  return Math.max(1, Math.min(MAX_CONTACT_WORKERS, cores - 2));
}

function failAll(reason: string): void {
  if (failed) return;
  failed = true;
  console.warn(`[render] Water contact worker failed; contacts rebuild on the main thread: ${reason}`);
  const members = slots.flatMap((slot) => [...slot.members.values()]);
  for (const slot of slots) slot.worker.terminate();
  slots.length = 0;
  for (const member of members) member.client.fail();
}

function spawn(): Slot | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./water-contact.worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    failAll(error instanceof Error ? error.message : String(error));
    return null;
  }
  const slot: Slot = { worker, members: new Map(), weight: 0 };
  worker.onmessage = (event: MessageEvent<WaterContactWorkerReply>) => slot.members.get(event.data.field)?.client.reply(event.data);
  worker.onerror = (event) => { event.preventDefault(); failAll(event.message || "worker error"); };
  worker.onmessageerror = () => failAll("unreadable reply");
  slots.push(slot);
  return slot;
}

/**
 * A place for a contact field on a contact worker, started on first use; null where workers are unavailable (no
 * `Worker`, as in tests and Node) or after a failure, so the field rebuilds on the main thread. `weight` is the field's
 * expected work (its texture's cells), so the largest fields land on different workers.
 */
export function attachWaterContactWorker(client: WaterContactWorkerClient, weight: number): WaterContactWorkerLink | null {
  if (failed || typeof Worker === "undefined") return null;
  let slot = slots.reduce<Slot | null>((best, next) => (!best || next.weight < best.weight ? next : best), null);
  if (!slot || (slot.members.size > 0 && slots.length < workerLimit())) slot = spawn();
  if (!slot) return null;
  const home = slot, field = ++fieldIds, member: Member = { client, weight };
  home.members.set(field, member); home.weight += weight; links++;
  let attached = true;
  const live = () => attached && home.members.get(field) === member && slots.includes(home);
  return {
    field,
    post(message, transfer) {
      if (!live()) return;
      try {
        home.worker.postMessage(message satisfies WaterContactWorkerRequest, transfer);
      } catch (error) {
        failAll(error instanceof Error ? error.message : String(error));
      }
    },
    fail: failAll,
    detach() {
      if (!attached) return;
      if (live()) {
        home.members.delete(field); home.weight -= weight;
        if (home.members.size === 0) { home.worker.terminate(); slots.splice(slots.indexOf(home), 1); }
        else home.worker.postMessage({ type: "drop", field } satisfies WaterContactWorkerRequest);
      }
      attached = false;
      if (--links === 0) failed = false;
    },
  };
}

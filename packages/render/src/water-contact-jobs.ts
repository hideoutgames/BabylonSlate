import { fillContactWindow, type ContactGrid, type ContactPiece, type ContactWindow } from "./water-contact-kernel";

/**
 * Messages between `WaterContactField` and the contact worker (`water-contact.worker.ts`). The worker keeps each
 * field's cut objects (pieces) between jobs, so a job carries only the pieces cut again since the last one and the
 * keys of those gone; their arrays are transferred, not copied.
 */
export type WaterContactJobMessage = {
  type: "job";
  field: number;
  job: number;
  /** Applied before `updated`, so a key removed and placed again in one job ends up placed. */
  removed: string[];
  updated: Array<{ key: string; piece: ContactPiece }>;
  grid: ContactGrid;
  windows: ContactWindow[];
};
/** The field is gone: its pieces are dropped. */
export type WaterContactDropMessage = { type: "drop"; field: number };
export type WaterContactWorkerRequest = WaterContactJobMessage | WaterContactDropMessage;

/** One RGBA8 block per job window, in order, each exactly the window's cells (rows `x1 - x0` cells wide). */
export type WaterContactResult = { type: "result"; field: number; job: number; blocks: Uint8Array[] };
export type WaterContactFailure = { type: "error"; field: number; job: number; message: string };
export type WaterContactWorkerReply = WaterContactResult | WaterContactFailure;

/**
 * The worker's side: applies each job's piece changes to that field's pieces, fills its windows with the same passes
 * the main thread runs (`fillContactWindow`) and posts the blocks back, transferring them.
 */
export function createWaterContactJobHandler(post: (reply: WaterContactWorkerReply, transfer: Transferable[]) => void): (request: WaterContactWorkerRequest) => void {
  const fields = new Map<number, Map<string, ContactPiece>>();
  return (request) => {
    if (request.type === "drop") { fields.delete(request.field); return; }
    const { field, job } = request;
    try {
      let pieces = fields.get(field);
      if (!pieces) { pieces = new Map(); fields.set(field, pieces); }
      for (const key of request.removed) pieces.delete(key);
      for (const { key, piece } of request.updated) pieces.set(key, piece);
      const blocks = request.windows.map((window) => {
        const width = window.x1 - window.x0, block = new Uint8Array(width * (window.z1 - window.z0) * 4);
        fillContactWindow(request.grid, pieces.values(), window, block, width, window.x0, window.z0);
        return block;
      });
      post({ type: "result", field, job, blocks }, blocks.map((block) => block.buffer));
    } catch (error) {
      post({ type: "error", field, job, message: error instanceof Error ? error.message : String(error) }, []);
    }
  };
}

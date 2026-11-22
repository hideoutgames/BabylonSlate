import { rasterContactWindow, type ContactRasterJob } from "./water-contact-raster";

/** One contact window to build (`water-contact-worker-client.ts`); `id` pairs the reply with its request. */
export type WaterContactWorkerRequest = { id: number; job: ContactRasterJob };
/** The window's texels (`rasterContactWindow`'s `out`), transferred, or why it could not be built. */
export type WaterContactWorkerReply = { id: number; texels: Uint8Array } | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WaterContactWorkerRequest>) => void) | null;
  postMessage(message: WaterContactWorkerReply, transfer?: Transferable[]): void;
};

// Jobs run one at a time, in the order they arrive; the rasteriser's scratch stays allocated between them.
scope.onmessage = (event) => {
  const { id, job } = event.data;
  try {
    const { write } = job;
    const texels = new Uint8Array((write.x1 - write.x0) * (write.z1 - write.z0) * 4);
    rasterContactWindow(job, texels);
    scope.postMessage({ id, texels }, [texels.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};

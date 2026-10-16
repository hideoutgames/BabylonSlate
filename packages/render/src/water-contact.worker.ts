import { createWaterContactJobHandler, type WaterContactWorkerReply, type WaterContactWorkerRequest } from "./water-contact-jobs";

/** Contact-field worker entry (`water-contact-offthread.ts` starts it): Babylon-free, one job at a time. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WaterContactWorkerRequest>) => void) | null;
  postMessage(message: WaterContactWorkerReply, transfer: Transferable[]): void;
};

const handle = createWaterContactJobHandler((reply, transfer) => scope.postMessage(reply, transfer));
scope.onmessage = (event) => handle(event.data);

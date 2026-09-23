import type { AreaEmissionProgress } from "./area-emission";
import type { AreaEmissionReply, AreaEmissionRequest } from "./area-emission-worker";

/** The shared EncodeQueue owns admission; each job owns and terminates its worker. */
export function processAreaEmissionInWorker(request: AreaEmissionRequest, signal: AbortSignal, onProgress?: (value: AreaEmissionProgress) => void): Promise<Uint8Array> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./area-emission-worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const cleanup = () => { settled = true; worker.terminate(); signal.removeEventListener("abort", cancel); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const cancel = () => fail(signal.reason ?? new Error("Area emission processing cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (event: MessageEvent<AreaEmissionReply>) => {
      if (settled) return;
      const message = event.data;
      if ("progress" in message) { try { onProgress?.(message.progress); } catch (error) { fail(error); } }
      else if ("error" in message) fail(new Error(message.error));
      else { cleanup(); resolve(message.bytes); }
    };
    worker.onerror = (event) => fail(new Error(event.message || "Area emission worker failed."));
    worker.onmessageerror = () => fail(new Error("Area emission worker returned an invalid message."));
    const source = request.source.slice();
    try { worker.postMessage({ ...request, source }, [source.buffer]); }
    catch (error) { fail(error); }
  });
}

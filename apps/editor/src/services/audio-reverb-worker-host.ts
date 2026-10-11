import {
  packAudioReverbTriangles,
  type AudioReverbGeometry,
} from "@babylonslate/assets";

type BakeResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string };

export type AudioReverbWorkerHost = {
  bake: (geometry: AudioReverbGeometry, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Stops the worker; any bake still waiting rejects with an AbortError. */
  terminate: () => void;
};

export function createAudioReverbWorker(): AudioReverbWorkerHost {
  const worker = new Worker(
    new URL(
      "../../../../packages/assets/src/audio-reverb-worker.ts",
      import.meta.url,
    ),
    { type: "module" },
  );
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
  >();
  // Set once the worker can no longer answer; later bakes reject with it.
  let closed: Error | null = null;
  const close = (error: Error) => {
    closed ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<BakeResponse>) => {
    const msg = event.data;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if ("error" in msg) {
      waiter.reject(new Error(msg.error));
      return;
    }
    waiter.resolve(msg.bytes);
  };
  // A worker that fails to load or crashes never replies, and neither error
  // names the request, so every waiting bake fails.
  worker.onerror = (event: ErrorEvent) => {
    close(
      new Error(
        event.message
          ? `Audio reverb bake worker failed: ${event.message}`
          : "Audio reverb bake worker failed.",
      ),
    );
  };
  worker.onmessageerror = () => {
    close(new Error("Audio reverb bake worker sent a reply that could not be read."));
  };
  return {
    bake(geometry, signal) {
      if (closed) return Promise.reject(closed);
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const onAbort = () => {
          pending.delete(id);
          reject(new Error("audio reverb bake cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const triangles = packAudioReverbTriangles(geometry);
        worker.postMessage({ id, triangles }, [triangles.buffer]);
      });
    },
    terminate() {
      worker.terminate();
      const error = new Error("Audio reverb bake aborted");
      error.name = "AbortError";
      close(error);
    },
  };
}

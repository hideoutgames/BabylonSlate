import {
  packAudioReverbTriangles,
  type AudioReverbGeometry,
} from "@babylonslate/assets";

type BakeResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string };

export type AudioReverbWorkerHost = {
  bake: (geometry: AudioReverbGeometry, signal?: AbortSignal) => Promise<Uint8Array>;
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
  return {
    bake(geometry, signal) {
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
      pending.clear();
    },
  };
}

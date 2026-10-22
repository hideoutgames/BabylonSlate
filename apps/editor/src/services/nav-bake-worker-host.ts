import type { NavMeshGenerateInput } from "@haptic/navigation";

type BakeResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string };

export type NavBakeWorkerHost = {
  generate: (input: NavMeshGenerateInput) => Promise<Uint8Array>;
  /** Stops the worker; any generate still waiting rejects with an AbortError. */
  terminate: () => void;
};

export function createNavBakeWorker(): NavBakeWorkerHost {
  const worker = new Worker(
    new URL(
      "../../../../packages/navigation/src/bake-worker.ts",
      import.meta.url,
    ),
    { type: "module" },
  );
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
  >();
  // Set once the worker can no longer answer; later generates reject with it.
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
          ? `Navmesh bake worker failed: ${event.message}`
          : "Navmesh bake worker failed.",
      ),
    );
  };
  worker.onmessageerror = () => {
    close(new Error("Navmesh bake worker sent a reply that could not be read."));
  };
  return {
    generate(input) {
      if (closed) return Promise.reject(closed);
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const positions = Float32Array.from(input.positions as ArrayLike<number>);
        const indices = Uint32Array.from(input.indices as ArrayLike<number>);
        worker.postMessage(
          { id, input: { positions, indices, settings: input.settings } },
          [positions.buffer, indices.buffer],
        );
      });
    },
    terminate() {
      worker.terminate();
      const error = new Error("Navmesh bake aborted");
      error.name = "AbortError";
      close(error);
    },
  };
}

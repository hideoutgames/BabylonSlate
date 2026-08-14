import type { NavMeshGenerateInput } from "@babylonslate/navigation";

type BakeResponse =
  | { id: number; ok: true; bytes: Uint8Array }
  | { id: number; ok: false; error: string };

export type NavBakeWorkerHost = {
  generate: (input: NavMeshGenerateInput) => Promise<Uint8Array>;
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
  worker.onmessage = (event: MessageEvent<BakeResponse>) => {
    const msg = event.data;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.bytes);
    else waiter.reject(new Error(msg.error));
  };
  return {
    generate(input) {
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
      pending.clear();
    },
  };
}

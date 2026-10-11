import type {
  NavMeshGenerateInput,
  NavMeshGenerateSettings,
} from "@babylonslate/navigation";

export type NavBakePhase =
  | "showing"
  | "collecting"
  | "generating"
  | "writing";

export type NavBakeGeometry = {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
};

export type RunNavBakeOptions = {
  waitPaintedFrame: () => Promise<void>;
  collect: () => NavBakeGeometry | Promise<NavBakeGeometry>;
  generate: (input: NavMeshGenerateInput) => Promise<Uint8Array>;
  write: (bytes: Uint8Array) => Promise<void>;
  settings: NavMeshGenerateSettings;
  onPhase: (phase: NavBakePhase) => void;
  signal?: AbortSignal;
};

function abortError(): Error {
  const error = new Error("Bake aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Settles with `work`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function geometryReady(geometry: NavBakeGeometry): boolean {
  return geometry.positions.length >= 9 && geometry.indices.length >= 3;
}

/** First-frame collect can miss meshes while the Viewport engine catches up. */
const COLLECT_ATTEMPTS = 8;

export async function runNavBake(options: RunNavBakeOptions): Promise<Uint8Array> {
  options.onPhase("showing");
  await options.waitPaintedFrame();
  throwIfAborted(options.signal);
  options.onPhase("collecting");
  let geometry = await options.collect();
  for (let attempt = 1; attempt < COLLECT_ATTEMPTS && !geometryReady(geometry); attempt += 1) {
    throwIfAborted(options.signal);
    await options.waitPaintedFrame();
    geometry = await options.collect();
  }
  if (!geometryReady(geometry)) {
    throw new Error("Navmesh bake needs scene geometry (MeshComponent actors).");
  }
  throwIfAborted(options.signal);
  options.onPhase("generating");
  // Cancel must not wait for a worker that may never reply; the caller
  // terminates it once the bake settles.
  const bytes = await untilAborted(
    options.generate({
      positions: geometry.positions,
      indices: geometry.indices,
      settings: options.settings,
    }),
    options.signal,
  );
  throwIfAborted(options.signal);
  options.onPhase("writing");
  await options.write(bytes);
  return bytes;
}

export function waitPaintedFrame(): Promise<void> {
  return new Promise((resolve) => {
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number;
    raf(() => raf(() => resolve()));
  });
}

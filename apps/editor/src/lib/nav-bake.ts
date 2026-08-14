import type { NavMeshGenerateInput, NavMeshSettings } from "@babylonslate/navigation";

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
  collect: () => NavBakeGeometry;
  generate: (input: NavMeshGenerateInput) => Promise<Uint8Array>;
  write: (bytes: Uint8Array) => Promise<void>;
  settings: Partial<NavMeshSettings>;
  onPhase: (phase: NavBakePhase) => void;
  signal?: AbortSignal;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Bake aborted");
  error.name = "AbortError";
  throw error;
}

export async function runNavBake(options: RunNavBakeOptions): Promise<Uint8Array> {
  options.onPhase("showing");
  await options.waitPaintedFrame();
  throwIfAborted(options.signal);
  options.onPhase("collecting");
  const geometry = options.collect();
  if (
    geometry.positions.length < 9 ||
    geometry.indices.length < 3
  ) {
    throw new Error("Navmesh bake needs scene geometry (MeshComponent actors).");
  }
  throwIfAborted(options.signal);
  options.onPhase("generating");
  const bytes = await options.generate({
    positions: geometry.positions,
    indices: geometry.indices,
    settings: options.settings,
  });
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

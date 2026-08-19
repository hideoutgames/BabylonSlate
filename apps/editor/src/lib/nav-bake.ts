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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Bake aborted");
  error.name = "AbortError";
  throw error;
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

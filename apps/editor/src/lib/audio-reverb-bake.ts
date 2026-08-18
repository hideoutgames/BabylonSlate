import {
  AUDIO_BAKE_DEBOUNCE_MS,
  AUDIO_BAKE_WORKER_TIMEOUT_MS,
  bakeAudioReverb,
  collectStaticAudioGeometry,
  dryAudioReverbFallbackBytes,
  geometryHashForAudioBake,
  type AudioReverbGeometry,
} from "@babylonslate/assets";
import type { SerializedActor, SerializedScene } from "@babylonslate/core";

export type AudioReverbBakeWrite = {
  path: string;
  bytes: Uint8Array;
  payload: Record<string, unknown>;
};

export type AudioReverbBakeDiagnostic = {
  code: string;
  message: string;
};

export type AudioReverbBakeScene = {
  actors?: readonly SerializedActor[];
} & Record<string, unknown>;

export type AudioReverbBakeController = {
  schedule(path: string, scene: AudioReverbBakeScene): void;
  flush(path: string, scene: AudioReverbBakeScene): Promise<void>;
  flushAll(
    scenes: ReadonlyArray<{ path: string; scene: AudioReverbBakeScene }>,
  ): Promise<void>;
  drain(): Promise<void>;
  dispose(): void;
};

function actorsOf(scene: AudioReverbBakeScene): readonly SerializedActor[] {
  return Array.isArray(scene.actors) ? scene.actors : [];
}

function yieldBakeSlice(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function isDynamicRigidBody(actor: SerializedActor): boolean {
  return actor.components.some(
    (component) =>
      component.classId === "RigidBodyComponent" &&
      component.properties.motionType === "dynamic",
  );
}

/** Cheap key so background debounce is not reset by unrelated document bumps. */
export function staticAudioGeometryFingerprint(
  scene: AudioReverbBakeScene,
): string {
  const parts: string[] = [];
  for (const actor of actorsOf(scene)) {
    if (isDynamicRigidBody(actor)) continue;
    for (const component of actor.components) {
      if (component.classId !== "MeshComponent") continue;
      parts.push(
        actor.id,
        JSON.stringify(actor.transform ?? null),
        component.id,
        JSON.stringify(component.transform ?? null),
        JSON.stringify(component.properties ?? null),
      );
    }
  }
  return parts.join("\0");
}

export function createAudioReverbBakeController(options: {
  write: (entry: AudioReverbBakeWrite) => Promise<void>;
  bake?: (
    geometry: AudioReverbGeometry,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  collect?: (scene: AudioReverbBakeScene) => Promise<AudioReverbGeometry>;
  debounceMs?: number;
  timeoutMs?: number;
  onDiagnostic?: (diagnostic: AudioReverbBakeDiagnostic) => void;
}): AudioReverbBakeController {
  const debounceMs = options.debounceMs ?? AUDIO_BAKE_DEBOUNCE_MS;
  const timeoutMs = options.timeoutMs ?? AUDIO_BAKE_WORKER_TIMEOUT_MS;
  const bake =
    options.bake ??
    (async (geometry: AudioReverbGeometry) => bakeAudioReverb(geometry));
  const collect =
    options.collect ??
    ((scene: AudioReverbBakeScene) =>
      collectStaticAudioGeometry({
        actors: actorsOf(scene),
        yieldSlice: yieldBakeSlice,
      }));

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Map<string, Promise<void>>();
  const lastHash = new Map<string, string>();
  const generation = new Map<string, number>();

  const bump = (path: string) => {
    const next = (generation.get(path) ?? 0) + 1;
    generation.set(path, next);
    return next;
  };

  const run = (path: string, scene: AudioReverbBakeScene): Promise<void> => {
    const gen = bump(path);
    const work = bakePath(path, scene, gen);
    inflight.set(path, work);
    return work.finally(() => {
      if (inflight.get(path) === work) inflight.delete(path);
    });
  };

  async function bakePath(
    path: string,
    scene: AudioReverbBakeScene,
    gen: number,
  ): Promise<void> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hash = lastHash.get(path) ?? "0";
    try {
      const geometry = await collect(scene);
      if (generation.get(path) !== gen) return;
      hash = geometryHashForAudioBake(geometry);
      if (lastHash.get(path) === hash) return;
      const timeout = new Promise<Uint8Array>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("audio reverb bake timed out"));
        }, timeoutMs);
      });
      void timeout.catch(() => undefined);
      const bytes = await Promise.race([bake(geometry, abort.signal), timeout]);
      if (generation.get(path) !== gen) return;
      await options.write({
        path,
        bytes,
        payload: scene as Record<string, unknown>,
      });
      lastHash.set(path, hash);
    } catch {
      if (generation.get(path) !== gen) return;
      options.onDiagnostic?.({
        code: "audio.reverb_bake_failed",
        message:
          "Audio reverb bake failed; writing a marked dry fallback so Save and export can continue.",
      });
      await options.write({
        path,
        bytes: dryAudioReverbFallbackBytes(hash),
        payload: scene as Record<string, unknown>,
      });
      lastHash.set(path, hash);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    schedule(path, scene) {
      const existing = pending.get(path);
      if (existing !== undefined) clearTimeout(existing);
      pending.set(
        path,
        setTimeout(() => {
          pending.delete(path);
          void run(path, scene);
        }, debounceMs),
      );
    },
    async flush(path, scene) {
      const existing = pending.get(path);
      if (existing !== undefined) {
        clearTimeout(existing);
        pending.delete(path);
      }
      await run(path, scene);
    },
    async flushAll(scenes) {
      await Promise.all(
        scenes.map((entry) => this.flush(entry.path, entry.scene)),
      );
    },
    drain() {
      return Promise.all([...inflight.values()]).then(() => undefined);
    },
    dispose() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const path of generation.keys()) bump(path);
    },
  };
}

let saveFlush: (() => Promise<void>) | null = null;

export function registerAudioReverbSaveFlush(
  flush: (() => Promise<void>) | null,
): void {
  saveFlush = flush;
}

/** Save/export await the current bake or a dry fallback. Never throws. */
export async function flushAudioReverbForSave(): Promise<void> {
  try {
    await saveFlush?.();
  } catch {
    // Dry fallback is written by the controller; Save must not hang or fail.
  }
}

export function sceneFromDocument(
  content: unknown,
): AudioReverbBakeScene | null {
  if (!content || typeof content !== "object") return null;
  const scene = content as Partial<SerializedScene>;
  if (!Array.isArray(scene.actors)) return null;
  return scene as AudioReverbBakeScene;
}

/** Load Scene documents (open or closed) and keep those with a Scene payload. */
export async function collectAudioReverbFlushScenes(options: {
  paths: readonly string[];
  load: (path: string) => Promise<unknown | null>;
}): Promise<Array<{ path: string; scene: AudioReverbBakeScene }>> {
  const scenes: Array<{ path: string; scene: AudioReverbBakeScene }> = [];
  for (const path of options.paths) {
    const scene = sceneFromDocument(await options.load(path));
    if (scene) scenes.push({ path, scene });
  }
  return scenes;
}

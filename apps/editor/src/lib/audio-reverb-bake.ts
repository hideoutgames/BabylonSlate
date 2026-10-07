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
import type { ProjectSceneWriter } from "../services/project-write-admission";

export type AudioReverbBakeWrite = {
  path: string;
  bytes: Uint8Array;
  payload: Record<string, unknown>;
};
type AudioReverbWrite = (entry: AudioReverbBakeWrite) => Promise<void>;

export type AudioReverbBakeDiagnostic = {
  code: string;
  message: string;
};

export type AudioReverbBakeScene = {
  actors?: readonly SerializedActor[];
} & Record<string, unknown>;

export type AudioReverbBakeSceneEntry = { path: string; scene: AudioReverbBakeScene };

export type AudioReverbBakeController = {
  schedule(path: string, scene: AudioReverbBakeScene): void;
  flush(path: string, scene: AudioReverbBakeScene, write?: AudioReverbWrite): Promise<void>;
  flushAll(
    scenes: readonly AudioReverbBakeSceneEntry[],
    write?: AudioReverbWrite,
  ): Promise<void>;
  drain(): Promise<void>;
  dispose(): void;
};

function actorsOf(scene: Pick<AudioReverbBakeScene, "actors">): readonly SerializedActor[] {
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
  scene: Pick<AudioReverbBakeScene, "actors">,
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
  write: AudioReverbWrite;
  withWrite?: (work: (write: AudioReverbWrite) => Promise<void>) => Promise<void>;
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
  const inflight = new Map<string, { fingerprint: string; work: Promise<void> }>();
  const completed = new Map<string, { hash: string; fingerprint: string; bytes: Uint8Array }>();
  const generation = new Map<string, number>();

  const bump = (path: string) => {
    const next = (generation.get(path) ?? 0) + 1;
    generation.set(path, next);
    return next;
  };

  const run = (path: string, scene: AudioReverbBakeScene, write?: AudioReverbWrite): Promise<void> => {
    const fingerprint = staticAudioGeometryFingerprint(scene);
    const existing = inflight.get(path);
    // Save must join the background bake through chunk persistence, not start
    // another rewrite while that job's hash has yet to enter the completed cache.
    if (existing?.fingerprint === fingerprint) return existing.work;
    const gen = bump(path);
    const bakeWith = (writer: AudioReverbWrite) => bakePath(path, scene, gen, fingerprint, writer);
    const work = write ? bakeWith(write) : options.withWrite ? options.withWrite(bakeWith) : bakeWith(options.write);
    const entry = { fingerprint, work };
    inflight.set(path, entry);
    return work.finally(() => {
      if (inflight.get(path) === entry) inflight.delete(path);
    });
  };

  async function bakePath(
    path: string,
    scene: AudioReverbBakeScene,
    gen: number,
    fingerprint: string,
    write: AudioReverbWrite,
  ): Promise<void> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hash = completed.get(path)?.hash ?? "0";
    try {
      const geometry = await collect(scene);
      if (generation.get(path) !== gen) return;
      hash = geometryHashForAudioBake(geometry);
      const cached = completed.get(path);
      if (cached?.hash === hash) {
        // A material or other non-geometric mesh edit may change the cheap
        // fingerprint without changing triangles. Reuse the bake, but associate
        // it with this snapshot so its later Save can persist the matching chunk.
        if (cached.fingerprint !== fingerprint) {
          await write({ path, bytes: cached.bytes, payload: scene });
          completed.set(path, { ...cached, fingerprint });
        }
        return;
      }
      const timeout = new Promise<Uint8Array>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("audio reverb bake timed out"));
        }, timeoutMs);
      });
      void timeout.catch(() => undefined);
      const bytes = await Promise.race([bake(geometry, abort.signal), timeout]);
      if (generation.get(path) !== gen) return;
      await write({
        path,
        bytes,
        payload: scene as Record<string, unknown>,
      });
      completed.set(path, { hash, fingerprint, bytes });
    } catch {
      if (generation.get(path) !== gen) return;
      options.onDiagnostic?.({
        code: "audio.reverb_bake_failed",
        message:
          "Audio reverb bake failed; writing a marked dry fallback so Save and export can continue.",
      });
      const bytes = dryAudioReverbFallbackBytes(hash);
      await write({
        path,
        bytes,
        payload: scene as Record<string, unknown>,
      });
      completed.set(path, { hash, fingerprint, bytes });
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
          // A session may close authoring admission while this debounce waits.
          void run(path, scene).catch(() => undefined);
        }, debounceMs),
      );
    },
    async flush(path, scene, write) {
      const existing = pending.get(path);
      if (existing !== undefined) {
        clearTimeout(existing);
        pending.delete(path);
      }
      await run(path, scene, write);
    },
    async flushAll(scenes, write) {
      await Promise.all(
        scenes.map((entry) => this.flush(entry.path, entry.scene, write)),
      );
    },
    drain() {
      return Promise.all([...inflight.values()].map((entry) => entry.work)).then(() => undefined);
    },
    dispose() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const path of generation.keys()) bump(path);
    },
  };
}

let saveFlush: ((scenes?: readonly AudioReverbBakeSceneEntry[], writer?: ProjectSceneWriter) => Promise<void>) | null = null;

export function registerAudioReverbSaveFlush(
  flush: typeof saveFlush,
): void {
  saveFlush = flush;
}

/** Save/export await the current bake or a dry fallback. Never throws. */
export async function flushAudioReverbForSave(scenes?: readonly AudioReverbBakeSceneEntry[], writer?: ProjectSceneWriter): Promise<void> {
  try {
    await saveFlush?.(scenes, writer);
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
}): Promise<AudioReverbBakeSceneEntry[]> {
  const scenes: AudioReverbBakeSceneEntry[] = [];
  for (const path of options.paths) {
    const scene = sceneFromDocument(await options.load(path));
    if (scene) scenes.push({ path, scene });
  }
  return scenes;
}

import {
  AUDIO_BAKE_DEBOUNCE_MS,
  AUDIO_BAKE_WORKER_TIMEOUT_MS,
  bakeAudioReverb,
  collectStaticAudioGeometry,
  dryAudioReverbFallbackBytes,
  geometryHashForAudioBake,
  type AudioReverbGeometry,
} from "@haptic/assets";
import type { SerializedActor, SerializedScene } from "@haptic/core";
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

/**
 * A flush whose result did not reach its Scene's `audioReverb` chunk, for
 * example while project writes are locked. `bytes` is the fresh result, or null
 * when none is known; the saved chunk is current only if it equals `bytes`.
 */
export class AudioReverbBakeUnsavedError extends Error {
  readonly bytes: Uint8Array | null;
  readonly reason: unknown;

  constructor(bytes: Uint8Array | null, reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "AudioReverbBakeUnsavedError";
    this.bytes = bytes;
    this.reason = reason;
  }

  /** True when `saved` already holds this fresh result, so nothing is stale. */
  matches(saved: Uint8Array | null | undefined): boolean {
    const bytes = this.bytes;
    return !!bytes && !!saved && saved.byteLength === bytes.byteLength &&
      saved.every((value, index) => value === bytes[index]);
  }
}

/** Scenes whose flushed result was not saved, by path. */
export type AudioReverbUnsavedResults = ReadonlyMap<string, AudioReverbBakeUnsavedError>;

export type AudioReverbBakeController = {
  schedule(path: string, scene: AudioReverbBakeScene): void;
  /** Rejects with `AudioReverbBakeUnsavedError` when the result cannot be saved. */
  flush(path: string, scene: AudioReverbBakeScene, write?: AudioReverbWrite): Promise<void>;
  /** Settles every Scene and reports the ones whose result was not saved. */
  flushAll(
    scenes: readonly AudioReverbBakeSceneEntry[],
    write?: AudioReverbWrite,
  ): Promise<AudioReverbUnsavedResults>;
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
  const actors = actorsOf(scene);
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  const parts: string[] = [];
  for (const actor of actors) {
    if (isDynamicRigidBody(actor)) continue;
    const meshes = actor.components.filter((component) => component.classId === "MeshComponent");
    if (meshes.length === 0) continue;
    parts.push(actor.id, JSON.stringify(actor.transform ?? null));
    // The bake places meshes through their actor attachments: every ancestor's
    // pose, and a missing or cyclic link, moves them.
    const seenActors = new Set([actor.id]);
    for (let parentId = actor.parentId ?? null; parentId; ) {
      if (seenActors.has(parentId)) { parts.push("cycle"); break; }
      seenActors.add(parentId);
      const parent = byId.get(parentId);
      parts.push(parentId, parent ? JSON.stringify(parent.transform ?? null) : "missing");
      parentId = parent?.parentId ?? null;
    }
    const components = new Map(actor.components.map((component) => [component.id, component]));
    for (const component of meshes) {
      parts.push(
        component.id,
        JSON.stringify(component.transform ?? null),
        JSON.stringify(component.properties ?? null),
      );
      // Parent components (and Spring Arm sockets) compose into the mesh pose.
      const seenComponents = new Set([component.id]);
      for (let parentId = component.parentId ?? null; parentId && !seenComponents.has(parentId); ) {
        seenComponents.add(parentId);
        const parent = components.get(parentId);
        parts.push(parentId, parent ? JSON.stringify([parent.transform ?? null, parent.properties ?? null]) : "missing");
        parentId = parent?.parentId ?? null;
      }
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
  const inflight = new Map<string, { fingerprint: string; flushing: boolean; work: Promise<void> }>();
  const completed = new Map<string, { hash: string; fingerprint: string; bytes: Uint8Array }>();
  const generation = new Map<string, number>();
  let disposed = false;

  const bump = (path: string) => {
    const next = (generation.get(path) ?? 0) + 1;
    generation.set(path, next);
    return next;
  };

  const run = (path: string, scene: AudioReverbBakeScene, write?: AudioReverbWrite, flushing = false): Promise<void> => {
    const fingerprint = staticAudioGeometryFingerprint(scene);
    const existing = inflight.get(path);
    // Save must join the background bake through chunk persistence, not start
    // another rewrite while that job's hash has yet to enter the completed cache.
    // A joining flush makes the bake its own: not superseded, and still baked
    // if admission refuses its write.
    if (existing?.fingerprint === fingerprint) {
      if (flushing) existing.flushing = true;
      return existing.work;
    }
    // A flush is never superseded: export packs the saved Scene it flushed, so
    // that snapshot's result must be saved or reported. Later work waits for it.
    if (existing?.flushing) {
      return existing.work.catch(() => undefined)
        .then(() => (disposed ? undefined : run(path, scene, write, flushing)));
    }
    const gen = bump(path);
    const bakeWith = (writer: AudioReverbWrite) => bakePath(path, scene, gen, fingerprint, writer);
    let admitted = !!write || !options.withWrite;
    const started = write ? bakeWith(write)
      : !options.withWrite ? bakeWith(options.write)
      : options.withWrite((writer) => { admitted = true; return bakeWith(writer); });
    const entry = { fingerprint, flushing, work: started };
    // Settled within the work itself, so a flush can join only while the
    // refusal fallback below is still possible.
    const settle = () => {
      if (inflight.get(path) === entry) inflight.delete(path);
    };
    entry.work = started.then(settle, (error: unknown) => {
      // While writes are locked (Simulation Play), a flush still bakes so export
      // learns whether the saved chunk already matches; a changed result is reported.
      if (admitted || !entry.flushing) {
        settle();
        throw error;
      }
      return bakeWith(() => Promise.reject(error)).finally(settle);
    });
    inflight.set(path, entry);
    return entry.work;
  };

  async function bakePath(
    path: string,
    scene: AudioReverbBakeScene,
    gen: number,
    fingerprint: string,
    write: AudioReverbWrite,
  ): Promise<void> {
    const fresh = await bakeFresh(path, scene, gen, fingerprint);
    if (!fresh) return;
    try {
      await write({ path, bytes: fresh.bytes, payload: scene as Record<string, unknown> });
    } catch (error) {
      throw new AudioReverbBakeUnsavedError(fresh.bytes, error);
    }
    completed.set(path, { hash: fresh.hash, fingerprint, bytes: fresh.bytes });
  }

  /** The result to write for this snapshot, or null when superseded or already written. */
  async function bakeFresh(
    path: string,
    scene: AudioReverbBakeScene,
    gen: number,
    fingerprint: string,
  ): Promise<{ hash: string; bytes: Uint8Array } | null> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hash = completed.get(path)?.hash ?? "0";
    try {
      const geometry = await collect(scene);
      if (generation.get(path) !== gen) return null;
      hash = geometryHashForAudioBake(geometry);
      const cached = completed.get(path);
      if (cached?.hash === hash) {
        // A material or other non-geometric mesh edit may change the cheap
        // fingerprint without changing triangles. Reuse the bake, but associate
        // it with this snapshot so its later Save can persist the matching chunk.
        return cached.fingerprint === fingerprint ? null : { hash, bytes: cached.bytes };
      }
      const timeout = new Promise<Uint8Array>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("audio reverb bake timed out"));
        }, timeoutMs);
      });
      void timeout.catch(() => undefined);
      const bytes = await Promise.race([bake(geometry, abort.signal), timeout]);
      if (generation.get(path) !== gen) return null;
      return { hash, bytes };
    } catch {
      if (generation.get(path) !== gen) return null;
      options.onDiagnostic?.({
        code: "audio.reverb_bake_failed",
        message:
          "Audio reverb bake failed; writing a marked dry fallback so Save and export can continue.",
      });
      return { hash, bytes: dryAudioReverbFallbackBytes(hash) };
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
      await run(path, scene, write, true);
    },
    async flushAll(scenes, write) {
      const settled = await Promise.allSettled(
        scenes.map((entry) => this.flush(entry.path, entry.scene, write)),
      );
      const unsaved = new Map<string, AudioReverbBakeUnsavedError>();
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const { reason } = result;
        unsaved.set(scenes[index]!.path, reason instanceof AudioReverbBakeUnsavedError
          ? reason
          : new AudioReverbBakeUnsavedError(null, reason));
      });
      return unsaved;
    },
    drain() {
      return Promise.all([...inflight.values()].map((entry) => entry.work)).then(() => undefined);
    },
    dispose() {
      disposed = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const path of generation.keys()) bump(path);
    },
  };
}

let saveFlush: ((scenes?: readonly AudioReverbBakeSceneEntry[], writer?: ProjectSceneWriter) => Promise<AudioReverbUnsavedResults>) | null = null;

export function registerAudioReverbSaveFlush(
  flush: typeof saveFlush,
): void {
  saveFlush = flush;
}

/**
 * Save/export await the current bake or a dry fallback. Never throws; reports
 * the Scenes whose result could not be saved so export can refuse stale chunks.
 */
export async function flushAudioReverbForSave(scenes?: readonly AudioReverbBakeSceneEntry[], writer?: ProjectSceneWriter): Promise<AudioReverbUnsavedResults> {
  try {
    return (await saveFlush?.(scenes, writer)) ?? new Map();
  } catch {
    // Dry fallback is written by the controller; Save must not hang or fail.
    return new Map();
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

export type AudioReverbFlushScenes = {
  scenes: AudioReverbBakeSceneEntry[];
  /** Scenes the bake could not load, by path, with the reason. */
  unreadable: Map<string, unknown>;
};

/**
 * Load Scene documents (open or closed) for the bake. A Scene that cannot be
 * loaded, whatever the reason, is reported rather than thrown: export fails on
 * it only when the game reaches it, and Save still bakes the others.
 */
export async function collectAudioReverbFlushScenes(options: {
  paths: readonly string[];
  load: (path: string) => Promise<unknown | null>;
}): Promise<AudioReverbFlushScenes> {
  const scenes: AudioReverbBakeSceneEntry[] = [];
  const unreadable = new Map<string, unknown>();
  for (const path of options.paths) {
    try {
      const scene = sceneFromDocument(await options.load(path));
      if (!scene) throw new Error(`${path} has no Scene document.`);
      scenes.push({ path, scene });
    } catch (error) {
      unreadable.set(path, error);
    }
  }
  return { scenes, unreadable };
}

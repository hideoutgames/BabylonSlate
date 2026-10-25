import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_BAKE_DEBOUNCE_MS,
  AUDIO_BAKE_WORKER_TIMEOUT_MS,
  AUDIO_GEOMETRY_COLLECT_SLICE,
  AUDIO_REVERB_VERSION,
  bakeAudioReverb,
  collectStaticAudioGeometry,
  decodeAudioReverbChunk,
  geometryHashForAudioBake,
  isDryAudioReverbFallback,
} from "@haptic/assets";
import { createActor, createMeshComponent, identitySerializedTransform } from "@haptic/core";
import {
  collectAudioReverbFlushScenes,
  createAudioReverbBakeController,
  staticAudioGeometryFingerprint,
  type AudioReverbBakeWrite,
} from "./audio-reverb-bake";

function boxActor(
  id: string,
  position: [number, number, number],
  options?: { dynamic?: boolean },
) {
  const components = [createMeshComponent(`${id}-mesh`, "box")];
  if (options?.dynamic) {
    components.push({
      id: `${id}-body`,
      classId: "RigidBodyComponent",
      properties: { motionType: "dynamic", mass: 1 },
    });
  }
  return createActor(id, id, {
    transform: {
      ...identitySerializedTransform(),
      position,
      scale: [4, 4, 4],
    },
    components,
  });
}

function sceneWith(actors: ReturnType<typeof boxActor>[]) {
  return { actors };
}

describe("audio reverb bake controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces static edits, caches matching hashes, and skips dynamic-only changes", async () => {
    vi.useFakeTimers();
    const writes: AudioReverbBakeWrite[] = [];
    const bakes: string[] = [];
    const controller = createAudioReverbBakeController({
      bake: async (geometry) => {
        bakes.push(geometryHashForAudioBake(geometry));
        return bakeAudioReverb(geometry);
      },
      write: async (entry) => {
        writes.push(entry);
      },
    });
    const wall = sceneWith([
      boxActor("wall", [0, 0, 0]),
      boxActor("wall-b", [12, 0, 0]),
      boxActor("wall-c", [0, 0, 12]),
    ]);
    controller.schedule("assets/Main.scene.hasset", wall);
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_DEBOUNCE_MS - 1);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await controller.drain();
    expect(writes).toHaveLength(1);
    expect(isDryAudioReverbFallback(decodeAudioReverbChunk(writes[0]!.bytes))).toBe(
      false,
    );

    controller.schedule("assets/Main.scene.hasset", wall);
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_DEBOUNCE_MS);
    await controller.drain();
    expect(bakes).toHaveLength(1);

    controller.schedule(
      "assets/Main.scene.hasset",
      sceneWith([
        boxActor("wall", [0, 0, 0]),
        boxActor("wall-b", [12, 0, 0]),
        boxActor("wall-c", [0, 0, 12]),
        boxActor("crate", [20, 0, 0], { dynamic: true }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_DEBOUNCE_MS);
    await controller.drain();
    expect(bakes).toHaveLength(1);

    controller.schedule(
      "assets/Main.scene.hasset",
      sceneWith([
        boxActor("wall", [10, 0, 0]),
        boxActor("wall-b", [12, 0, 0]),
        boxActor("wall-c", [0, 0, 12]),
      ]),
    );
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_DEBOUNCE_MS);
    await controller.drain();
    expect(bakes).toHaveLength(2);
    expect(writes).toHaveLength(2);
  });

  it.each(["baking", "writing"] as const)("Save joins matching background work while %s and waits for its single persisted chunk", async (phase) => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writes: AudioReverbBakeWrite[] = [];
    const bakes: string[] = [];
    const controller = createAudioReverbBakeController({
      bake: async (geometry) => {
        bakes.push(geometryHashForAudioBake(geometry));
        if (phase === "baking") await gate;
        return new Uint8Array([1, 2, 3]);
      },
      write: async (entry) => {
        writes.push(entry);
        if (phase === "writing") await gate;
      },
    });
    const scene = sceneWith([boxActor("wall", [0, 0, 0])]);
    controller.schedule("assets/Main.scene.hasset", scene);
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_DEBOUNCE_MS);
    let saved = false;
    const save = controller.flush("assets/Main.scene.hasset", structuredClone(scene)).then(() => { saved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toBe(false);
    expect(bakes).toHaveLength(1);
    expect(writes).toHaveLength(phase === "writing" ? 1 : 0);
    release();
    await save;
    await controller.drain();
    expect(saved).toBe(true);
    expect(writes).toHaveLength(1);
    expect([...writes[0]!.bytes]).toEqual([1, 2, 3]);

    await controller.flush("assets/Main.scene.hasset", sceneWith([boxActor("wall", [8, 0, 0])]));
    expect(bakes).toHaveLength(2);
    expect(writes).toHaveLength(2);
    expect((writes[1]!.payload.actors as ReturnType<typeof boxActor>[])[0]!.transform.position).toEqual([8, 0, 0]);
    controller.dispose();
  });

  it("does not join a stale background bake when Save requests changed geometry", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writes: AudioReverbBakeWrite[] = [];
    let bakes = 0;
    const controller = createAudioReverbBakeController({
      bake: async () => {
        bakes += 1;
        if (bakes === 1) await gate;
        return new Uint8Array([bakes]);
      },
      write: async (entry) => { writes.push(entry); },
    });
    controller.schedule("assets/Main.scene.hasset", sceneWith([boxActor("wall", [0, 0, 0])]));
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_DEBOUNCE_MS);
    await controller.flush("assets/Main.scene.hasset", sceneWith([boxActor("wall", [8, 0, 0])]));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(bakes).toBe(2);
    expect(writes).toHaveLength(1);
    expect((writes[0]!.payload.actors as ReturnType<typeof boxActor>[])[0]!.transform.position).toEqual([8, 0, 0]);
    controller.dispose();
  });

  it("reports the fresh result when a flush joins a background bake that writes refused", async () => {
    let refuse!: (error: Error) => void;
    // The first admission (the background bake) is refused asynchronously; later ones at once.
    const locked = new Error("Read-only during Simulation Play");
    const withWrite = vi.fn<(work: (write: (entry: AudioReverbBakeWrite) => Promise<void>) => Promise<void>) => Promise<void>>()
      .mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }))
      .mockImplementation(() => Promise.reject(locked));
    const controller = createAudioReverbBakeController({
      debounceMs: 0,
      bake: async () => new Uint8Array([2]),
      write: async () => { throw new Error("bakes write through withWrite"); },
      withWrite,
    });
    const scene = sceneWith([boxActor("wall", [0, 0, 0])]);
    controller.schedule("assets/Main.scene.hasset", scene);
    await vi.waitFor(() => expect(withWrite).toHaveBeenCalledOnce());
    const flushed = controller.flushAll([{ path: "assets/Main.scene.hasset", scene: structuredClone(scene) }]);
    refuse(locked);
    const unsaved = (await flushed).get("assets/Main.scene.hasset");
    expect(unsaved?.reason).toBe(locked);
    expect(unsaved?.bytes).toEqual(new Uint8Array([2]));
    controller.dispose();
  });

  it("reuses a geometry hash for material edits while publishing the new Scene snapshot", async () => {
    const writes: AudioReverbBakeWrite[] = [];
    const bake = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const controller = createAudioReverbBakeController({ bake, write: async (entry) => { writes.push(entry); } });
    const scene = sceneWith([boxActor("wall", [0, 0, 0])]);
    await controller.flush("Main", scene);
    const next = structuredClone(scene);
    next.actors[0]!.components[0]!.properties.materialGuid = "new-material";
    await controller.flush("Main", next);
    expect(bake).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(2);
    expect(writes[1]!.payload).toBe(next);
    expect(writes[1]!.bytes).toEqual(writes[0]!.bytes);
    await controller.flush("Main", next);
    expect(writes).toHaveLength(2);
    controller.dispose();
  });

  it("flush writes a marked dry fallback on timeout", async () => {
    vi.useFakeTimers();
    const writes: AudioReverbBakeWrite[] = [];
    const diagnostics: Array<{ code: string }> = [];
    let release!: () => void;
    const controller = createAudioReverbBakeController({
      bake: () =>
        new Promise((resolve) => {
          release = () => resolve(new Uint8Array([1, 2, 3]));
        }),
      write: async (entry) => {
        writes.push(entry);
      },
      timeoutMs: AUDIO_BAKE_WORKER_TIMEOUT_MS,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const scene = sceneWith([boxActor("wall", [0, 0, 0])]);
    const flush = controller.flush("assets/Main.scene.hasset", scene);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_WORKER_TIMEOUT_MS);
    await flush;
    expect(writes).toHaveLength(1);
    const field = decodeAudioReverbChunk(writes[0]!.bytes);
    expect(isDryAudioReverbFallback(field)).toBe(true);
    expect(field?.version).toBe(AUDIO_REVERB_VERSION);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "audio.reverb_bake_failed" }),
    ]);
    release();
  });

  it("gives each Scene in a flush its own bake timeout", async () => {
    vi.useFakeTimers();
    const timeoutMs = 1_000;
    const writes: AudioReverbBakeWrite[] = [];
    const diagnostics: Array<{ code: string }> = [];
    // One bake thread: each job starts when the one before it finishes.
    let thread = Promise.resolve();
    const controller = createAudioReverbBakeController({
      timeoutMs,
      bake: () => {
        const job = thread.then(() => new Promise<Uint8Array>((resolve) => {
          setTimeout(() => resolve(new Uint8Array([7])), timeoutMs * 0.6);
        }));
        thread = job.then(() => undefined);
        return job;
      },
      write: async (entry) => {
        writes.push(entry);
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const flushed = controller.flushAll([
      { path: "assets/A.scene.hasset", scene: sceneWith([boxActor("a", [0, 0, 0])]) },
      { path: "assets/B.scene.hasset", scene: sceneWith([boxActor("b", [8, 0, 0])]) },
    ]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(timeoutMs * 2);
    expect((await flushed).size).toBe(0);
    expect(diagnostics).toEqual([]);
    expect(writes.map((entry) => [entry.path, [...entry.bytes]])).toEqual([
      ["assets/A.scene.hasset", [7]],
      ["assets/B.scene.hasset", [7]],
    ]);
    controller.dispose();
  });

  it("bakes an edit made to one Scene while a flush is still baking another", async () => {
    const sceneB = "assets/B.scene.hasset";
    const savedA = sceneWith([boxActor("a", [0, 0, 0])]);
    const edited = sceneWith([boxActor("b", [30, 0, 0])]);
    const hashOf = async (scene: ReturnType<typeof sceneWith>) =>
      geometryHashForAudioBake(await collectStaticAudioGeometry({ actors: scene.actors }));
    const [hashA, editedHash] = await Promise.all([hashOf(savedA), hashOf(edited)]);
    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
    let bakingA = false;
    const heldEdits: Array<() => void> = [];
    let flushSettled = false;
    const writes: AudioReverbBakeWrite[] = [];
    const controller = createAudioReverbBakeController({
      debounceMs: 0,
      bake: async (geometry) => {
        const hash = geometryHashForAudioBake(geometry);
        if (hash === hashA) {
          bakingA = true;
          await heldA;
        } else if (!flushSettled && hash === editedHash) {
          // The edit's bake outlasts the flush, which reaches B while it runs.
          await new Promise<void>((resolve) => { heldEdits.push(resolve); });
        }
        return new Uint8Array([1]);
      },
      write: async (entry) => { writes.push(entry); },
    });
    const flushed = controller.flushAll([
      { path: "assets/A.scene.hasset", scene: savedA },
      { path: sceneB, scene: sceneWith([boxActor("b", [8, 0, 0])]) },
    ]);
    await vi.waitFor(() => expect(bakingA).toBe(true));
    // The user moves B's wall in its open tab while the flush bakes A.
    controller.schedule(sceneB, edited);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseA();
    expect((await flushed).size).toBe(0);
    flushSettled = true;
    for (const release of heldEdits) release();
    await vi.waitFor(() => {
      expect(writes.filter((entry) => entry.path === sceneB).at(-1)?.payload).toBe(edited);
    });
    controller.dispose();
  });

  it("runs at most bakeSlots bakes at once and stops a superseded bake", async () => {
    const signals: AbortSignal[] = [];
    const controller = createAudioReverbBakeController({
      debounceMs: 0,
      bakeSlots: 1,
      // As the worker host does, an abort rejects the bake (and stops its worker).
      bake: (_geometry, signal) => new Promise((_, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
      write: async () => undefined,
    });
    controller.schedule("assets/A.scene.hasset", sceneWith([boxActor("a", [0, 0, 0])]));
    controller.schedule("assets/B.scene.hasset", sceneWith([boxActor("b", [0, 0, 0])]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals).toHaveLength(1);
    // Moving A's wall supersedes its bake, which gives up its slot to B.
    controller.schedule("assets/A.scene.hasset", sceneWith([boxActor("a", [5, 0, 0])]));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    controller.dispose();
  });

  it.each(["times out", "fails"] as const)("gives a queued Scene the bake slot when the bake holding it %s", async (outcome) => {
    vi.useFakeTimers();
    const timeoutMs = 1_000;
    const failAtMs = timeoutMs / 2;
    const signals: AbortSignal[] = [];
    const writes: AudioReverbBakeWrite[] = [];
    const diagnostics: Array<{ code: string }> = [];
    const controller = createAudioReverbBakeController({
      timeoutMs,
      bakeSlots: 1,
      bake: (_geometry, signal) => {
        signals.push(signal);
        if (signals.length > 1) return Promise.resolve(new Uint8Array([7]));
        // A's worker hangs without ever settling, or crashes before its timeout.
        return new Promise((_, reject) => {
          if (outcome === "fails") setTimeout(() => reject(new Error("worker crashed")), failAtMs);
        });
      },
      write: async (entry) => { writes.push(entry); },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const flushed = controller.flushAll([
      { path: "assets/A.scene.hasset", scene: sceneWith([boxActor("a", [0, 0, 0])]) },
      { path: "assets/B.scene.hasset", scene: sceneWith([boxActor("b", [8, 0, 0])]) },
    ]);
    const settleAtMs = outcome === "fails" ? failAtMs : timeoutMs;
    await vi.advanceTimersByTimeAsync(settleAtMs - 1);
    expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toHaveLength(2);
    // A timed-out bake's signal stops its worker.
    if (outcome === "times out") expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect((await flushed).size).toBe(0);
    const written = new Map(writes.map((entry) => [entry.path, entry.bytes]));
    expect(isDryAudioReverbFallback(decodeAudioReverbChunk(written.get("assets/A.scene.hasset")!))).toBe(true);
    expect([...written.get("assets/B.scene.hasset")!]).toEqual([7]);
    expect(diagnostics).toEqual([expect.objectContaining({ code: "audio.reverb_bake_failed" })]);
    controller.dispose();
  });

  it("flush of empty static geometry writes dry fallback without hanging", async () => {
    const writes: AudioReverbBakeWrite[] = [];
    const controller = createAudioReverbBakeController({
      bake: async (geometry) => bakeAudioReverb(geometry),
      write: async (entry) => {
        writes.push(entry);
      },
    });
    await controller.flush(
      "assets/Main.scene.hasset",
      sceneWith([boxActor("crate", [0, 0, 0], { dynamic: true })]),
    );
    expect(writes).toHaveLength(1);
    expect(isDryAudioReverbFallback(decodeAudioReverbChunk(writes[0]!.bytes))).toBe(
      true,
    );
  });

  it("yields during default geometry collect so Save stays responsive", async () => {
    const originalRaf = globalThis.requestAnimationFrame;
    let yielded = 0;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      yielded += 1;
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
    try {
      const actors = Array.from({ length: AUDIO_GEOMETRY_COLLECT_SLICE }, (_, i) =>
        boxActor(`wall-${i}`, [i * 4, 0, 0]),
      );
      const writes: AudioReverbBakeWrite[] = [];
      const controller = createAudioReverbBakeController({
        write: async (entry) => {
          writes.push(entry);
        },
      });
      await controller.flush("assets/Main.scene.hasset", sceneWith(actors));
      expect(yielded).toBeGreaterThan(0);
      expect(writes).toHaveLength(1);
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });
});

describe("collectStaticAudioGeometry used by the bake controller", () => {
  it("matches the controller hash cache key", async () => {
    const actors = [boxActor("wall", [0, 0, 0])];
    const geometry = await collectStaticAudioGeometry({ actors });
    expect(geometryHashForAudioBake(geometry).length).toBeGreaterThan(0);
  });
});

describe("collectAudioReverbFlushScenes", () => {
  it("loads every scene path, including ones that are not open", async () => {
    const loaded = await collectAudioReverbFlushScenes({
      paths: ["assets/Open.scene.hasset", "assets/Closed.scene.hasset"],
      load: async (path) => {
        if (path.includes("Closed")) {
          return sceneWith([boxActor("wall", [8, 0, 0])]);
        }
        return sceneWith([boxActor("open", [0, 0, 0])]);
      },
    });
    expect(loaded.scenes.map((entry) => entry.path)).toEqual([
      "assets/Open.scene.hasset",
      "assets/Closed.scene.hasset",
    ]);
    expect(loaded.scenes[1]?.scene.actors?.[0]?.id).toBe("wall");
    expect(loaded.unreadable.size).toBe(0);
  });

  it("reports each Scene it cannot load and still collects the rest", async () => {
    const failure = new Error("read failed");
    const loaded = await collectAudioReverbFlushScenes({
      paths: ["assets/Broken.scene.hasset", "assets/Empty.scene.hasset", "assets/Main.scene.hasset"],
      load: async (path) => {
        if (path.includes("Broken")) throw failure;
        if (path.includes("Empty")) return null;
        return sceneWith([boxActor("wall", [0, 0, 0])]);
      },
    });
    expect(loaded.scenes.map((entry) => entry.path)).toEqual(["assets/Main.scene.hasset"]);
    expect(loaded.unreadable.get("assets/Broken.scene.hasset")).toBe(failure);
    expect(loaded.unreadable.get("assets/Empty.scene.hasset")).toBeInstanceOf(Error);
  });
});

describe("staticAudioGeometryFingerprint", () => {
  it("ignores dynamic rigid bodies", () => {
    const staticOnly = sceneWith([boxActor("wall", [0, 0, 0])]);
    const withDynamic = sceneWith([
      boxActor("wall", [0, 0, 0]),
      boxActor("crate", [20, 0, 0], { dynamic: true }),
    ]);
    expect(staticAudioGeometryFingerprint(staticOnly)).toBe(
      staticAudioGeometryFingerprint(withDynamic),
    );
    expect(staticAudioGeometryFingerprint(staticOnly)).not.toBe(
      staticAudioGeometryFingerprint(sceneWith([boxActor("wall", [10, 0, 0])])),
    );
  });

  it("changes when an ancestor of a static mesh moves", () => {
    const attached = (rootX: number) => {
      const root = createActor("root", "Root", {
        transform: { ...identitySerializedTransform(), position: [rootX, 0, 0] },
      });
      return sceneWith([root, { ...boxActor("wall", [0, 0, 0]), parentId: "root" }]);
    };
    expect(staticAudioGeometryFingerprint(attached(0))).not.toBe(
      staticAudioGeometryFingerprint(attached(10)),
    );
  });
});

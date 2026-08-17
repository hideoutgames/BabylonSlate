import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_BAKE_DEBOUNCE_MS,
  AUDIO_BAKE_WORKER_TIMEOUT_MS,
  AUDIO_REVERB_VERSION,
  bakeAudioReverb,
  collectStaticAudioGeometry,
  decodeAudioReverbChunk,
  geometryHashForAudioBake,
  isDryAudioReverbFallback,
} from "@babylonslate/assets";
import { createActor, createMeshComponent, identitySerializedTransform } from "@babylonslate/core";
import {
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
    controller.schedule("assets/Main.scene.babasset", wall);
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_DEBOUNCE_MS - 1);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await controller.drain();
    expect(writes).toHaveLength(1);
    expect(isDryAudioReverbFallback(decodeAudioReverbChunk(writes[0]!.bytes))).toBe(
      false,
    );

    controller.schedule("assets/Main.scene.babasset", wall);
    await vi.advanceTimersByTimeAsync(AUDIO_BAKE_DEBOUNCE_MS);
    await controller.drain();
    expect(bakes).toHaveLength(1);

    controller.schedule(
      "assets/Main.scene.babasset",
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
      "assets/Main.scene.babasset",
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

  it("flush awaits the in-flight bake or writes a marked dry fallback on timeout", async () => {
    vi.useFakeTimers();
    const writes: AudioReverbBakeWrite[] = [];
    const diagnostics: Array<{ code: string }> = [];
    let release: (() => void) | null = null;
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
    const flush = controller.flush("assets/Main.scene.babasset", scene);
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
    release?.();
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
      "assets/Main.scene.babasset",
      sceneWith([boxActor("crate", [0, 0, 0], { dynamic: true })]),
    );
    expect(writes).toHaveLength(1);
    expect(isDryAudioReverbFallback(decodeAudioReverbChunk(writes[0]!.bytes))).toBe(
      true,
    );
  });
});

describe("collectStaticAudioGeometry used by the bake controller", () => {
  it("matches the controller hash cache key", async () => {
    const actors = [boxActor("wall", [0, 0, 0])];
    const geometry = await collectStaticAudioGeometry({ actors });
    expect(geometryHashForAudioBake(geometry).length).toBeGreaterThan(0);
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
});

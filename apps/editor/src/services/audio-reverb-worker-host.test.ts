import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioReverbGeometry } from "@babylonslate/assets";
import { createAudioReverbWorker } from "./audio-reverb-worker-host";

class SilentWorker {
  static last: SilentWorker | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  constructor() {
    SilentWorker.last = this;
  }
  postMessage() {}
}

const geometry: AudioReverbGeometry = { triangles: [] };

describe("createAudioReverbWorker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a waiting bake as aborted when terminated", async () => {
    vi.stubGlobal("Worker", SilentWorker);
    const host = createAudioReverbWorker();
    const bake = host.bake(geometry);
    host.terminate();
    await expect(bake).rejects.toMatchObject({ name: "AbortError" });
    await expect(host.bake(geometry)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails a waiting bake when the worker errors instead of replying", async () => {
    vi.stubGlobal("Worker", SilentWorker);
    const host = createAudioReverbWorker();
    const bake = host.bake(geometry);
    SilentWorker.last!.onerror!({ message: "wasm trap" });
    await expect(bake).rejects.toThrow(/wasm trap/);
  });
});

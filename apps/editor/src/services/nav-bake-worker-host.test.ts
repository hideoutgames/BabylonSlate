import { afterEach, describe, expect, it, vi } from "vitest";
import { createNavBakeWorker } from "./nav-bake-worker-host";

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

const input = { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2], settings: {} };

describe("createNavBakeWorker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails a waiting bake when the worker errors instead of replying", async () => {
    vi.stubGlobal("Worker", SilentWorker);
    const host = createNavBakeWorker();
    const bake = host.generate(input);
    SilentWorker.last!.onerror!({ message: "wasm trap" });
    await expect(bake).rejects.toThrow(/wasm trap/);
    await expect(host.generate(input)).rejects.toThrow(/wasm trap/);
  });

  it("rejects a waiting bake as aborted when terminated", async () => {
    vi.stubGlobal("Worker", SilentWorker);
    const host = createNavBakeWorker();
    const bake = host.generate(input);
    host.terminate();
    await expect(bake).rejects.toMatchObject({ name: "AbortError" });
    expect(SilentWorker.last!.terminate).toHaveBeenCalledOnce();
  });
});

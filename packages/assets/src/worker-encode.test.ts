import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerEncodeFn } from "./worker-encode";

vi.mock("./decode-source-rgba", () => ({
  decodeSourceToRgba: async () => ({
    rgba: new Uint8Array(4),
    width: 1,
    height: 1,
    clamped: false,
  }),
}));

class FakeWorker extends EventTarget {
  postMessage = vi.fn((msg: { type: string; id?: number }) => {
    if (msg.type === "init") {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent("message", { data: { type: "loaded" } }),
        );
      });
    }
  });
  terminate = vi.fn();
}

describe("createWorkerEncodeFn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("respawns the worker after an init error so later encodes can retry", async () => {
    let constructed = 0;
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          constructed += 1;
          const worker = new FakeWorker();
          if (constructed === 1) {
            worker.postMessage = vi.fn((msg: { type: string }) => {
              if (msg.type === "init") {
                queueMicrotask(() => {
                  worker.dispatchEvent(
                    new MessageEvent("message", {
                      data: { type: "error", error: "worker init failed" },
                    }),
                  );
                });
              }
            });
          }
          return worker;
        }
      },
    );

    const encode = createWorkerEncodeFn({ workerUrl: "/basis/encode-worker.js" });
    const settings = {
      format: "uastc" as const,
      quality: 2,
      maxDimension: 64,
      generateMipmaps: true,
    };
    await expect(encode(new Uint8Array([1]), settings)).rejects.toThrow(
      /worker init failed/,
    );
    expect(constructed).toBe(1);

    const retry = encode(new Uint8Array([1]), settings);
    await vi.waitFor(() => expect(constructed).toBe(2));
    encode.dispose();
    await retry.catch(() => undefined);
  });

  it("rejects in-flight encodes when the worker errors after load", async () => {
    let worker: FakeWorker | null = null;
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          worker = new FakeWorker();
          return worker;
        }
      },
    );

    const encode = createWorkerEncodeFn({ workerUrl: "/basis/encode-worker.js" });
    const pending = encode(new Uint8Array([1, 2, 3]), {
      format: "uastc",
      quality: 2,
      maxDimension: 64,
      generateMipmaps: true,
    });
    await vi.waitFor(() => {
      expect(worker).not.toBeNull();
      expect(
        worker?.postMessage.mock.calls.some((call) => call[0]?.type === "encode"),
      ).toBe(true);
    });
    worker!.dispatchEvent(new Event("error"));
    await expect(pending).rejects.toThrow(/encode worker/i);
    encode.dispose();
  });
});

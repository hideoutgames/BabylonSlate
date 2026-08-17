import { afterEach, describe, expect, it, vi } from "vitest";
import { canUseWorkerEncode, createWorkerEncodeFn } from "./worker-encode";

function isSourceEncodeRequest(message: {
  type?: string;
  source?: unknown;
  rgba?: unknown;
}): boolean {
  return message.type === "encode" && message.source instanceof ArrayBuffer;
}

function isRgbaEncodeRequest(message: {
  type?: string;
  source?: unknown;
  rgba?: unknown;
}): boolean {
  return message.type === "encode" && message.rgba instanceof ArrayBuffer;
}

const decodeSourceToRgba = vi.hoisted(() =>
  vi.fn(async () => ({
    rgba: new Uint8Array(4),
    width: 1,
    height: 1,
    clamped: false,
  })),
);

vi.mock("./decode-source-rgba", () => ({
  decodeSourceToRgba,
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

  it("transfers source bytes and MIME instead of decoded RGBA", async () => {
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
    const source = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const pending = encode(
      source,
      {
        format: "uastc",
        quality: 2,
        maxDimension: 64,
        generateMipmaps: true,
      },
      "image/png",
    );
    await vi.waitFor(() => {
      expect(
        worker?.postMessage.mock.calls.some((call) => call[0]?.type === "encode"),
      ).toBe(true);
    });
    const encodeCall = worker!.postMessage.mock.calls.find(
      (call) => call[0]?.type === "encode",
    );
    const message = encodeCall![0];
    expect(isSourceEncodeRequest(message)).toBe(true);
    expect(isRgbaEncodeRequest(message)).toBe(false);
    expect(message.mime).toBe("image/png");
    expect(message.source).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(message.source as ArrayBuffer)).toEqual(source);
    expect(encodeCall![1]).toEqual([message.source]);
    expect(decodeSourceToRgba).not.toHaveBeenCalled();
    encode.dispose();
    await pending.catch(() => undefined);
  });

  it("falls back to main-thread decode when the worker cannot decode", async () => {
    let worker: FakeWorker | null = null;
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          worker = new FakeWorker();
          worker.postMessage = vi.fn((msg: { type: string; id?: number }) => {
            if (msg.type === "init") {
              queueMicrotask(() => {
                worker!.dispatchEvent(
                  new MessageEvent("message", { data: { type: "loaded" } }),
                );
              });
            }
            if (msg.type === "encode" && msg.id != null && !("rgba" in msg)) {
              queueMicrotask(() => {
                worker!.dispatchEvent(
                  new MessageEvent("message", {
                    data: {
                      type: "decode_unavailable",
                      id: msg.id,
                      error: "createImageBitmap rejected",
                    },
                  }),
                );
              });
            }
          });
          return worker;
        }
      },
    );

    const encode = createWorkerEncodeFn({ workerUrl: "/basis/encode-worker.js" });
    const pending = encode(
      new Uint8Array([0xff, 0xd8]),
      {
        format: "uastc",
        quality: 2,
        maxDimension: 64,
        generateMipmaps: true,
      },
      "image/jpeg",
    );
    await vi.waitFor(
      () => {
        expect(decodeSourceToRgba).toHaveBeenCalledWith(
          expect.any(Uint8Array),
          64,
          "image/jpeg",
        );
        expect(
          worker?.postMessage.mock.calls.some(
            (call) => call[0]?.type === "encode" && isRgbaEncodeRequest(call[0]),
          ),
        ).toBe(true);
      },
      { timeout: 1000 },
    );
    encode.dispose();
    await pending.catch(() => undefined);
  });

  it("does not recycle or reject an in-flight encode", async () => {
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

    const encode = createWorkerEncodeFn({
      workerUrl: "/basis/encode-worker.js",
      recycleAfter: 1,
    });
    const settings = {
      format: "uastc" as const,
      quality: 2,
      maxDimension: 64,
      generateMipmaps: true,
    };
    const first = encode(new Uint8Array([1]), settings, "image/png");
    const second = encode(new Uint8Array([2]), settings, "image/png");
    await vi.waitFor(() => {
      expect(
        worker?.postMessage.mock.calls.filter((call) => call[0]?.type === "encode")
          .length,
      ).toBeGreaterThanOrEqual(1);
    });
    const firstId = worker!.postMessage.mock.calls.find(
      (call) => call[0]?.type === "encode",
    )![0].id as number;
    worker!.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "encoded",
          id: firstId,
          ktx2: new Uint8Array([9]).buffer,
          wallMs: 1,
        },
      }),
    );
    await expect(first).resolves.toMatchObject({ wallMs: 1 });
    await expect(
      Promise.race([
        second.then(() => "resolved"),
        Promise.resolve("still-pending"),
      ]),
    ).resolves.toBe("still-pending");
    expect(worker!.terminate).not.toHaveBeenCalled();
    encode.dispose();
    await second.catch(() => undefined);
  });

  it("can use a Worker even when OffscreenCanvas is missing on the main thread", () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("createImageBitmap", undefined);
    // @ts-expect-error deliberate unset for Safari / WKWebView host checks
    delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
    expect(canUseWorkerEncode()).toBe(true);
  });
});

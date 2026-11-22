import { afterEach, describe, expect, it, vi } from "vitest";
import { contactRasterTarget, rasterContactWindow, WATER_CONTACT_LAYER_OFFSETS, type ContactRasterJob } from "./water-contact-raster";
import type { WaterContactWorkerReply, WaterContactWorkerRequest } from "./water-contact.worker";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** A small job: one square post near the corner of a 24 × 20 allocation. */
function job(): ContactRasterJob {
  const grid = { width: 24, height: 20, rectMinX: 0, rectMinZ: 0, cell: 0.1, range: 0.6, amplitude: 0.3, smoothRadius: 1 };
  const write = { x0: 2, z0: 3, x1: 22, z1: 18 };
  const square = new Float64Array([0.5, 0.5, 0.9, 0.5, 0.9, 0.5, 0.9, 0.9, 0.9, 0.9, 0.5, 0.9, 0.5, 0.9, 0.5, 0.5]);
  const pieces = [{ contours: WATER_CONTACT_LAYER_OFFSETS.map(() => square.slice()), closed: WATER_CONTACT_LAYER_OFFSETS.map(() => true), triangles: new Float64Array() }];
  return { ...grid, target: contactRasterTarget(grid, write), write, pieces };
}

const texelsOf = (request: ContactRasterJob) => {
  const out = new Uint8Array((request.write.x1 - request.write.x0) * (request.write.z1 - request.write.z0) * 4);
  rasterContactWindow(request, out);
  return out;
};

describe("water contact worker", () => {
  it("answers each job with the rasteriser's texels, transferred, and a job it cannot build with an error", async () => {
    const replies: WaterContactWorkerReply[] = [], transferred: Transferable[][] = [];
    const scope = {
      onmessage: null as ((event: { data: WaterContactWorkerRequest }) => void) | null,
      // Real structured cloning rejects a detached or duplicated transfer list, and detaches what it transfers.
      postMessage: (message: WaterContactWorkerReply, transfer?: Transferable[]) => {
        transferred.push(transfer ?? []);
        replies.push(structuredClone(message, { transfer }));
      },
    };
    vi.stubGlobal("self", scope);
    await import("./water-contact.worker");
    const request = job();
    scope.onmessage!({ data: { id: 7, job: request } });
    scope.onmessage!({ data: { id: 8, job: { ...request, write: { x0: 5, z0: 0, x1: 2, z1: 4 } } } });
    expect(replies).toHaveLength(2);
    const [built, failed] = replies;
    if (!built || !("texels" in built)) throw new Error("The first job failed.");
    expect(built.id).toBe(7);
    expect(Array.from(built.texels)).toEqual(Array.from(texelsOf(request)));
    // Its buffer moved to the main thread rather than being copied.
    expect(transferred[0]).toHaveLength(1);
    expect((transferred[0]![0] as ArrayBuffer).byteLength).toBe(0);
    // The post is inside on every layer, and open water far.
    expect(built.texels.some((value) => value < 128)).toBe(true);
    expect(built.texels.some((value) => value === 255)).toBe(true);
    expect(failed).toMatchObject({ id: 8, error: expect.any(String) });
  });
});

/** A stand-in for the module worker: records what it is sent, and the test answers or fails it. */
class FakeWorker {
  static created: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WaterContactWorkerReply>) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly sent: WaterContactWorkerRequest[] = [];
  terminated = false;
  readonly url: URL;
  readonly options: WorkerOptions | undefined;
  constructor(url: URL, options?: WorkerOptions) { this.url = url; this.options = options; FakeWorker.created.push(this); }
  postMessage(message: WaterContactWorkerRequest): void { this.sent.push(structuredClone(message)); }
  terminate(): void { this.terminated = true; }
  reply(reply: WaterContactWorkerReply): void { this.onmessage?.({ data: reply } as MessageEvent<WaterContactWorkerReply>); }
}

describe("water contact worker client", () => {
  const client = async () => {
    FakeWorker.created = [];
    vi.stubGlobal("Worker", FakeWorker);
    const { sharedContactRaster } = await import("./water-contact-worker-client");
    return sharedContactRaster()!;
  };

  it("starts one module worker on the first job and resolves each job with its own reply", async () => {
    const raster = await client();
    // Shared by every caller, and no worker until a job is sent.
    const { sharedContactRaster } = await import("./water-contact-worker-client");
    expect(sharedContactRaster()).toBe(raster);
    expect(FakeWorker.created).toHaveLength(0);
    const first = raster.run(job()), second = raster.run(job());
    expect(FakeWorker.created).toHaveLength(1);
    const worker = FakeWorker.created[0]!;
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.url.pathname.endsWith("/water-contact.worker.ts")).toBe(true);
    const [a, b] = worker.sent;
    worker.reply({ id: b!.id, texels: new Uint8Array([2]) });
    worker.reply({ id: a!.id, texels: new Uint8Array([1]) });
    expect(Array.from(await first)).toEqual([1]);
    expect(Array.from(await second)).toEqual([2]);
    expect(raster.available).toBe(true);
  });

  for (const [name, fail] of [
    ["an error event", (worker: FakeWorker) => worker.onerror!({ message: "boom", preventDefault() {} })],
    ["an unreadable reply", (worker: FakeWorker) => worker.onmessageerror!()],
    ["a job that fails", (worker: FakeWorker) => worker.reply({ id: worker.sent[0]!.id, error: "bad job" })],
  ] as const) {
    it(`disables itself for good after ${name}: every pending job rejects, one warning, the worker stops`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const raster = await client();
      const jobs = [raster.run(job()), raster.run(job())];
      const worker = FakeWorker.created[0]!;
      fail(worker);
      for (const pending of jobs) await expect(pending).rejects.toThrow();
      expect(raster.available).toBe(false);
      expect(worker.terminated).toBe(true);
      // Later jobs reject at once, without another worker.
      await expect(raster.run(job())).rejects.toThrow();
      expect(FakeWorker.created).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  }

  it("fails a job the worker does not answer in time", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const raster = await client();
    const { WATER_CONTACT_WORKER_TIMEOUT_MS } = await import("./water-contact-worker-client");
    const pending = raster.run(job());
    const outcome = pending.then(() => "answered", () => "failed");
    await vi.advanceTimersByTimeAsync(WATER_CONTACT_WORKER_TIMEOUT_MS - 1);
    // Still waiting just short of the limit.
    expect(raster.available).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("failed");
    expect(raster.available).toBe(false);
    expect(FakeWorker.created[0]!.terminated).toBe(true);
  });

  it("does not exist where workers do not", async () => {
    vi.stubGlobal("Worker", undefined);
    const { sharedContactRaster } = await import("./water-contact-worker-client");
    expect(sharedContactRaster()).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpfsFileOps, OpfsFailure, type OpfsFileOps } from "./opfs-file-ops";
import { createOpfsWorkerClient } from "./opfs-worker-client";
import { createMemoryOpfsRoot } from "./test-support/memory-opfs";
import { createMemoryOpfsWorker, type MemoryOpfsWorker } from "./test-support/memory-opfs-worker";

const PROJECT = "project-v2-test";
const bytes = (...values: number[]) => new Uint8Array(values);

/** Operations whose named calls wait until `release()`; the work itself is the real one. */
function gated(ops: OpfsFileOps, names: Array<keyof OpfsFileOps>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered: string[] = [];
  const wrapped = { ...ops };
  for (const name of names) {
    const original = ops[name] as (...args: unknown[]) => Promise<unknown>;
    (wrapped as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      entered.push(name);
      await gate;
      return original(...args);
    };
  }
  return { ops: wrapped as OpfsFileOps, entered, release };
}

async function until(condition: () => boolean) {
  for (let turn = 0; !condition(); turn++) {
    if (turn > 1000) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("OPFS storage worker client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function client(options: { workerOps?: (root: FileSystemDirectoryHandle) => OpfsFileOps; start?: boolean } = {}) {
    const root = createMemoryOpfsRoot();
    const direct = createOpfsFileOps(async () => root);
    await direct.ensureProjectDir(PROJECT);
    const workers: MemoryOpfsWorker[] = [];
    const mainThread = vi.fn(() => createOpfsFileOps(async () => root));
    const files = createOpfsWorkerClient(() => {
      const worker = createMemoryOpfsWorker(options.workerOps?.(root) ?? createOpfsFileOps(async () => root), { start: options.start });
      workers.push(worker);
      return worker;
    }, mainThread);
    return { root, files, direct, workers, mainThread };
  }

  it("runs operations in the worker without detaching the caller's bytes", async () => {
    const { files, direct, workers, mainThread } = await client();
    const whole = bytes(1, 2, 3, 4, 5, 6);
    const view = whole.subarray(2, 5);
    await files.writeBinary(PROJECT, "a/view.bin", view);
    await files.writeBinary(PROJECT, "a/whole.bin", whole);
    expect(whole).toEqual(bytes(1, 2, 3, 4, 5, 6));
    expect(view).toEqual(bytes(3, 4, 5));

    expect(await direct.readBinary(PROJECT, "a/view.bin")).toEqual(bytes(3, 4, 5));
    expect(await files.readBinary(PROJECT, "a/whole.bin")).toEqual(whole);
    expect((await files.readRange(PROJECT, "a/whole.bin", 1, 2, 0)).bytes).toEqual(bytes(2, 3));
    expect((await files.readdir(PROJECT, "a")).map((entry) => entry.name)).toEqual(["view.bin", "whole.bin"]);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.received.map((request) => request.op)).toEqual(["writeBinary", "writeBinary", "readBinary", "readRange", "readdir"]);
    expect(mainThread).not.toHaveBeenCalled();
  });

  it("rebuilds failures as tagged values carrying the error's name and message", async () => {
    const { files } = await client();
    const failure = await files.readBinary(PROJECT, "missing.bin").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpfsFailure);
    expect(failure).toMatchObject({ kind: "not-found", path: "missing.bin", cause: { name: "NotFoundError" } });
    expect((failure as OpfsFailure).reason()).toMatchObject({ name: "NotFoundError", message: "Entry not found" });
  });

  it("runs the waiting work and every later call on the main thread when the worker fails before it is ready", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { files, workers, direct } = await client({ start: false });
    const write = files.writeBinary(PROJECT, "saved.bin", bytes(4, 2));
    const listing = files.readdir(PROJECT, "");
    workers[0]!.crash("script blocked");
    await write;
    expect(await listing).toBeInstanceOf(Array);
    expect(await direct.readBinary(PROJECT, "saved.bin")).toEqual(bytes(4, 2));
    expect(await files.readBinary(PROJECT, "saved.bin")).toEqual(bytes(4, 2));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.received).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays on the main thread when the worker cannot be created or never starts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = createMemoryOpfsRoot();
    const refused = createOpfsWorkerClient(() => { throw new Error("module workers are unsupported"); }, () => createOpfsFileOps(async () => root));
    await refused.ensureProjectDir(PROJECT);
    expect(await refused.exists(PROJECT, "")).toBe(true);

    vi.useFakeTimers();
    const { files, workers } = await client({ start: false });
    const pending = files.exists(PROJECT, "");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe(true);
    expect(workers[0]!.received).toEqual([]);
  });

  it("rejects an in-flight mutation when the worker fails after it started, and repeats in-flight reads on the main thread", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let blocked!: ReturnType<typeof gated>;
    const { files, workers, direct } = await client({
      workerOps: (root) => (blocked = gated(createOpfsFileOps(async () => root), ["writeBinary", "readBinary", "remove"])).ops,
    });
    await direct.writeBinary(PROJECT, "kept.bin", bytes(1));
    const write = files.writeBinary(PROJECT, "asset.bin", bytes(9));
    const remove = files.remove(PROJECT, "kept.bin");
    const read = files.readBinary(PROJECT, "kept.bin");
    await until(() => blocked.entered.length === 3);
    workers[0]!.crash();

    const interrupted = await write.catch((error: unknown) => error);
    expect(interrupted).toMatchObject({ kind: "interrupted", path: "asset.bin" });
    expect((interrupted as OpfsFailure).message).toMatch(/may or may not have completed/);
    await expect(remove).rejects.toMatchObject({ kind: "interrupted", path: "kept.bin" });
    expect(await read).toEqual(bytes(1));
    // The worker never ran them, and nothing repeated them.
    expect(await direct.exists(PROJECT, "asset.bin")).toBe(false);
    expect(await direct.exists(PROJECT, "kept.bin")).toBe(true);

    await files.writeBinary(PROJECT, "asset.bin", bytes(7));
    expect(await direct.readBinary(PROJECT, "asset.bin")).toEqual(bytes(7));
    expect(workers).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

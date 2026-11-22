import { describe, expect, it, vi } from "vitest";
import type { ProjectFolderHandle } from "@haptic/core";
import type { NativeTransferOptions, NativeTransferProgress, NativeTransferResult } from "./capacitor-scoped-storage";

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "ios" },
  registerPlugin: () => ({}),
}));
// `getHostPlatform` reads the Capacitor bridge global that the native shells inject.
(globalThis as { Capacitor?: unknown }).Capacitor = { getPlatform: () => "ios" };

const { capacitorFileTransfer } = await import("./capacitor-file-transfer");
const { isFileTransferError } = await import("./native-file-transfer-port");

const GAME: ProjectFolderHandle = { id: "documents:Game", name: "Game", tier: "documents" };
const SHA = "a".repeat(64);

/**
 * The storage plugin's transfer methods as the native side answers them:
 * each `transferFile` waits until the test settles it, so a cancel or a
 * progress event can arrive while it runs.
 */
function fakePlugin() {
  const calls: NativeTransferOptions[] = [];
  const cancels: string[] = [];
  const running = new Map<string, { resolve(result: NativeTransferResult): void; reject(error: unknown): void }>();
  let listener: ((progress: NativeTransferProgress) => void) | null = null;
  const plugin = {
    transferFile: vi.fn((options: NativeTransferOptions) => {
      calls.push(options);
      return new Promise<NativeTransferResult>((resolve, reject) => running.set(options.id, { resolve, reject }));
    }),
    cancelTransfer: vi.fn(async ({ id }: { id: string }) => {
      cancels.push(id);
      running.get(id)?.reject(Object.assign(new Error("Cancelled"), { code: "CANCELLED" }));
    }),
    writeRandomObject: vi.fn(async () => ({ sha256: SHA })),
    addListener: vi.fn(async (_event: "transferProgress", callback: (progress: NativeTransferProgress) => void) => {
      listener = callback;
      return { remove: async () => {} };
    }),
  };
  return {
    plugin,
    calls,
    cancels,
    settle: (id: string, outcome: NativeTransferResult | { code: string; message: string }) => {
      const transfer = running.get(id)!;
      if ("code" in outcome) transfer.reject(Object.assign(new Error(outcome.message), { code: outcome.code }));
      else transfer.resolve(outcome);
    },
    progress: (event: NativeTransferProgress) => listener?.(event),
  };
}

const started = async (fake: ReturnType<typeof fakePlugin>, count = 1) => {
  await vi.waitFor(() => expect(fake.calls).toHaveLength(count));
  return fake.calls[count - 1]!;
};

describe("capacitorFileTransfer", () => {
  it("names the project file in app storage and passes the request's headers and expected object through unchanged", async () => {
    const fake = fakePlugin();
    const transfer = capacitorFileTransfer("DATA", fake.plugin);
    const headers = { Authorization: "RemoteAuth storage-token", "Content-Type": "application/octet-stream", "x-Custom": "1" };
    const pending = transfer.transfer(GAME, { method: "PUT", url: "https://lfs.example/objects/1", headers, path: `assets/.blobs/${SHA}`, expected: { size: 3, sha256: SHA } });
    const call = await started(fake);
    expect(call).toEqual({
      id: call.id,
      method: "PUT",
      url: "https://lfs.example/objects/1",
      headers,
      directory: "DATA",
      path: `Haptic/projects/Game/assets/.blobs/${SHA}`,
      expectedSize: 3,
      expectedSha256: SHA,
    });
    fake.settle(call.id, { status: 200, bytes: 3, sha256: SHA });
    expect(await pending).toEqual({ status: 200, bytes: 3, sha256: SHA });
  });

  it("refuses a chosen folder, an app-owned library folder and a path out of the project without asking the plugin", async () => {
    const fake = fakePlugin();
    const transfer = capacitorFileTransfer("DOCUMENTS", fake.plugin);
    const request = { method: "GET" as const, url: "https://lfs.example/objects/1", headers: {}, path: "assets/.blobs/x" };
    for (const [folder, path] of [
      [{ id: "external-1", name: "Chosen", tier: "external" }, "assets/.blobs/x"],
      [{ id: "documents:__haptic_templates__", name: "__haptic_templates__", tier: "documents" }, "assets/.blobs/x"],
      [GAME, "../Other/assets/.blobs/x"],
      [GAME, ""],
    ] as Array<[ProjectFolderHandle, string]>) {
      const error = await transfer.transfer(folder, { ...request, path }).catch((reason: unknown) => reason);
      expect(isFileTransferError(error, "transfer-refused")).toBe(true);
    }
    expect(fake.plugin.transferFile).not.toHaveBeenCalled();
  });

  it("cancels the native transfer by its id when the signal aborts, and never starts one already aborted", async () => {
    const fake = fakePlugin();
    const transfer = capacitorFileTransfer("DOCUMENTS", fake.plugin);
    const controller = new AbortController();
    const pending = transfer.transfer(GAME, { method: "GET", url: "https://lfs.example/objects/1", headers: {}, path: "assets/.blobs/x", signal: controller.signal });
    const call = await started(fake);
    controller.abort();
    const error = await pending.catch((reason: unknown) => reason);
    expect(isFileTransferError(error, "transfer-cancelled")).toBe(true);
    expect(fake.cancels).toEqual([call.id]);

    const aborted = await transfer.transfer(GAME, { method: "GET", url: "https://lfs.example/objects/1", headers: {}, path: "assets/.blobs/x", signal: controller.signal }).catch((reason: unknown) => reason);
    expect(isFileTransferError(aborted, "transfer-cancelled")).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it("honours a cancel that arrives while the first progress listener is still being added", async () => {
    const fake = fakePlugin();
    let added: () => void = () => {};
    const adding = new Promise<void>((resolve) => (added = resolve));
    fake.plugin.addListener.mockImplementationOnce(async () => {
      await adding;
      return { remove: async () => {} };
    });
    const transfer = capacitorFileTransfer("DOCUMENTS", fake.plugin);
    const controller = new AbortController();
    const pending = transfer.transfer(GAME, { method: "GET", url: "https://lfs.example/a", headers: {}, path: "assets/.blobs/a", signal: controller.signal, onProgress: () => {} });
    await vi.waitFor(() => expect(fake.plugin.addListener).toHaveBeenCalledTimes(1));
    controller.abort();
    added();
    const error = await pending.catch((reason: unknown) => reason);
    expect(isFileTransferError(error, "transfer-cancelled")).toBe(true);
    // Nothing started, so nothing runs to the end unasked.
    expect(fake.calls).toEqual([]);
  });

  it("adds the progress listener again after adding it failed once", async () => {
    const fake = fakePlugin();
    fake.plugin.addListener.mockRejectedValueOnce(new Error("bridge unavailable"));
    const transfer = capacitorFileTransfer("DOCUMENTS", fake.plugin);
    const failed = await transfer.transfer(GAME, { method: "GET", url: "https://lfs.example/a", headers: {}, path: "assets/.blobs/a", onProgress: () => {} }).catch((reason: unknown) => reason);
    expect((failed as Error).message).toBe("bridge unavailable");

    const heard: number[] = [];
    const pending = transfer.transfer(GAME, { method: "GET", url: "https://lfs.example/b", headers: {}, path: "assets/.blobs/b", onProgress: (bytes) => heard.push(bytes) });
    const call = await started(fake);
    fake.progress({ id: call.id, bytes: 7 });
    fake.settle(call.id, { status: 200, bytes: 7, sha256: SHA });
    await pending;
    expect(heard).toEqual([7]);
    expect(fake.plugin.addListener).toHaveBeenCalledTimes(2);
  });

  it("routes each progress event to its own transfer", async () => {
    const fake = fakePlugin();
    const transfer = capacitorFileTransfer("DOCUMENTS", fake.plugin);
    const first: number[] = [];
    const second: number[] = [];
    const a = transfer.transfer(GAME, { method: "GET", url: "https://lfs.example/a", headers: {}, path: "assets/.blobs/a", onProgress: (bytes) => first.push(bytes) });
    const callA = await started(fake);
    const b = transfer.transfer(GAME, { method: "GET", url: "https://lfs.example/b", headers: {}, path: "assets/.blobs/b", onProgress: (bytes) => second.push(bytes) });
    const callB = await started(fake, 2);
    fake.progress({ id: callA.id, bytes: 10 });
    fake.progress({ id: callB.id, bytes: 5 });
    fake.progress({ id: callA.id, bytes: 20 });
    fake.settle(callA.id, { status: 200, bytes: 20, sha256: SHA });
    fake.settle(callB.id, { status: 200, bytes: 5, sha256: SHA });
    await Promise.all([a, b]);
    // A finished transfer hears nothing more.
    fake.progress({ id: callA.id, bytes: 30 });
    expect([first, second]).toEqual([[10, 20], [5]]);
    expect(fake.plugin.addListener).toHaveBeenCalledTimes(1);
  });

  it("types the plugin's refusals and passes other failures through as they came", async () => {
    const fake = fakePlugin();
    const transfer = capacitorFileTransfer("DOCUMENTS", fake.plugin);
    const outcomes: unknown[] = [];
    for (const [code, message] of [["MISMATCH", "The downloaded file arrived damaged."], ["UNREACHABLE", "Invalid Documents path"], ["NETWORK", "The Internet connection appears to be offline."]]) {
      const pending = transfer.transfer(GAME, { method: "GET", url: "https://lfs.example/a", headers: {}, path: "assets/.blobs/a" });
      const call = await started(fake, outcomes.length + 1);
      fake.settle(call.id, { code: code!, message: message! });
      outcomes.push(await pending.catch((reason: unknown) => reason));
    }
    expect(isFileTransferError(outcomes[0], "transfer-mismatch")).toBe(true);
    expect(isFileTransferError(outcomes[1], "transfer-refused")).toBe(true);
    expect(isFileTransferError(outcomes[2])).toBe(false);
    expect((outcomes[2] as Error).message).toBe("The Internet connection appears to be offline.");
  });

  it("has the host write the benchmark's random objects into the project's folder", async () => {
    const fake = fakePlugin();
    const transfer = capacitorFileTransfer("DATA", fake.plugin);
    expect(await transfer.writeRandomObject!(GAME, "assets/.blobs", 256)).toEqual({ path: `assets/.blobs/${SHA}`, sha256: SHA });
    expect(fake.plugin.writeRandomObject).toHaveBeenCalledWith({ directory: "DATA", path: "Haptic/projects/Game/assets/.blobs", size: 256 });
  });
});

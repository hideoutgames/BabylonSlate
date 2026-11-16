import { describe, expect, it, vi } from "vitest";
import type { ProjectFolderHandle } from "@haptic/core";
import { electronFileTransfer } from "./native-file-transfer";
import { folderFileTransfer, isFileTransferError, type NativeFileTransfer } from "./native-file-transfer-port";
import type { ElectronFileTransferBridge, ElectronFileTransferRequest, ElectronFileTransferResult } from "./platform";

const GAME: ProjectFolderHandle = { id: "node:/projects/Game", name: "Game", tier: "documents" };
const SHA = "b".repeat(64);

function fakeBridge() {
  const requests: Array<{ folderId: string; request: ElectronFileTransferRequest }> = [];
  const cancels: string[] = [];
  const running = new Map<string, (result: ElectronFileTransferResult) => void>();
  let listener: ((id: string, bytes: number) => void) | null = null;
  const bridge: ElectronFileTransferBridge = {
    transfer: vi.fn((folderId: string, request: ElectronFileTransferRequest) => {
      requests.push({ folderId, request });
      return new Promise<ElectronFileTransferResult>((resolve) => running.set(request.id, resolve));
    }),
    cancel: vi.fn(async (id: string) => {
      cancels.push(id);
      running.get(id)?.({ error: "The transfer was cancelled.", errorCode: "transfer-cancelled" });
    }),
    onProgress: vi.fn((callback: (id: string, bytes: number) => void) => {
      listener = callback;
      return () => {};
    }),
  };
  return { bridge, requests, cancels, settle: (id: string, result: ElectronFileTransferResult) => running.get(id)!(result), progress: (id: string, bytes: number) => listener?.(id, bytes) };
}

describe("electronFileTransfer", () => {
  it("asks main to stream the window's own project file, sending only the request's fields", async () => {
    const fake = fakeBridge();
    const progress: number[] = [];
    const pending = electronFileTransfer(fake.bridge).transfer(GAME, {
      method: "GET",
      url: "https://lfs.example/objects/1",
      headers: { Authorization: "RemoteAuth token" },
      path: `assets/.blobs/${SHA}`,
      expected: { size: 9, sha256: SHA },
      onProgress: (bytes) => progress.push(bytes),
    });
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    const { folderId, request } = fake.requests[0]!;
    expect(folderId).toBe(GAME.id);
    // Exactly the keys main's IPC validation allows: no signal, callback or redirect flag crosses.
    expect(request).toEqual({ id: request.id, method: "GET", url: "https://lfs.example/objects/1", headers: { Authorization: "RemoteAuth token" }, path: `assets/.blobs/${SHA}`, expected: { size: 9, sha256: SHA } });
    fake.progress("another", 1);
    fake.progress(request.id, 4);
    fake.settle(request.id, { status: 200, bytes: 9, sha256: SHA });
    expect(await pending).toEqual({ status: 200, bytes: 9, sha256: SHA });
    expect(progress).toEqual([4]);
  });

  it("restores main's failure codes, and cancels in main when the signal aborts", async () => {
    const fake = fakeBridge();
    const transfer = electronFileTransfer(fake.bridge);
    const request = { method: "GET" as const, url: "https://lfs.example/objects/1", headers: {}, path: "assets/.blobs/x" };
    const mismatched = transfer.transfer(GAME, request);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    fake.settle(fake.requests[0]!.request.id, { error: "The downloaded file arrived damaged.", errorCode: "transfer-mismatch" });
    expect(isFileTransferError(await mismatched.catch((error: unknown) => error), "transfer-mismatch")).toBe(true);

    const offline = transfer.transfer(GAME, request);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(2));
    fake.settle(fake.requests[1]!.request.id, { error: "fetch failed" });
    const failure = await offline.catch((error: unknown) => error);
    expect([isFileTransferError(failure), (failure as Error).message]).toEqual([false, "fetch failed"]);

    const controller = new AbortController();
    const cancelled = transfer.transfer(GAME, { ...request, signal: controller.signal });
    await vi.waitFor(() => expect(fake.requests).toHaveLength(3));
    controller.abort();
    expect(isFileTransferError(await cancelled.catch((error: unknown) => error), "transfer-cancelled")).toBe(true);
    expect(fake.cancels).toEqual([fake.requests[2]!.request.id]);
  });
});

describe("folderFileTransfer", () => {
  it("transfers in the folder the storage has bound at each call, and refuses once it has none", async () => {
    const seen: string[] = [];
    const native: NativeFileTransfer = {
      transfer: async (folder) => {
        seen.push(folder.id);
        return { status: 200, bytes: 0, sha256: "" };
      },
    };
    let current: ProjectFolderHandle | null = GAME;
    const bound = folderFileTransfer(native, { getCurrentFolder: () => current });
    const request = { method: "PUT" as const, url: "https://lfs.example/objects/1", headers: {}, path: "assets/.blobs/x" };
    await bound.transfer(request);
    current = null;
    expect(isFileTransferError(await bound.transfer(request).catch((error: unknown) => error), "transfer-refused")).toBe(true);
    expect(seen).toEqual([GAME.id]);
    expect(bound.writeRandomObject).toBeUndefined();
  });
});

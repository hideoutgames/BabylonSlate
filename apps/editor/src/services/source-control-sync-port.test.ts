import { describe, expect, it, vi } from "vitest";
import type { ProjectStorage } from "@haptic/core";
import type { HttpRequest } from "@haptic/source-control";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { cloneIntoFolder, monitoredHttp, testRemote } from "./source-control-sync-port";

describe("monitoredHttp", () => {
  it("counts the bytes each request sends and receives", async () => {
    const bytes = vi.fn();
    const http = vi.fn(async (request: HttpRequest) =>
      request.responseType === "binary" ? { status: 200, bodyText: "", bodyBytes: new Uint8Array(1000) } : { status: 200, bodyText: "héllo" });
    const monitored = monitoredHttp(http, { bytes });
    await monitored({ method: "POST", url: "https://git.example.com/a", headers: {}, body: new Uint8Array(300), responseType: "binary" });
    await monitored({ method: "GET", url: "https://git.example.com/b", headers: {} });
    expect(bytes.mock.calls).toEqual([[1300], [6]]);
  });
});

/** `storage` aborting `controller` at its first write. */
function abortingOnWrite(storage: ProjectStorage, controller: AbortController): ProjectStorage {
  return new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (property !== "writeBinary") return (value as (...args: unknown[]) => unknown).bind(target);
      return (...args: unknown[]) => {
        controller.abort();
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe("cloneIntoFolder", () => {
  it("ends a clone cancelled while it writes the working copy as cancelled", async () => {
    const repositoryUrl = "https://github.com/team/cancelled-clone.git";
    (await testRemote(repositoryUrl)).commit({ "project.json": "{}", "assets/a.hasset": "A", "assets/b.hasset": "B" }, "Seed");
    const memory = new MemoryStorageAdapter("documents");
    const folder = await memory.openDocumentsProject("Clone");
    const controller = new AbortController();
    const clone = cloneIntoFolder({
      storage: abortingOnWrite(memory, controller),
      folderId: folder.id,
      repositoryUrl,
      branch: "main",
      testMode: true,
      transfer: { bytes: () => {} },
      signal: controller.signal,
    });
    await expect(clone).rejects.toMatchObject({ kind: "cancelled" });
  });
});

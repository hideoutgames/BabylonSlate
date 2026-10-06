import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpCatalogStorageAdapter, type HttpStorageCatalog } from "./http-catalog-storage";

async function catalog(): Promise<HttpStorageCatalog> {
  const hash = async (bytes: number[]) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map(value => value.toString(16).padStart(2, "0")).join("");
  return { version: 1, files: [{ path: "pack/large.babasset", size: 6, revision: "asset-one", parts: [
    { offset: 0, length: 2, file: "header", sha256: await hash([1, 2]) },
    { offset: 2, length: 4, file: "payload", sha256: await hash([3, 4, 5, 6]) },
  ] }] };
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("HTTP catalog storage", () => {
  it("browses without fetching files and reads independent header/chunk objects on ordinary static hosts", async () => {
    const fetcher = vi.fn<typeof fetch>(async function (this: unknown, input) {
      expect(this).toBeUndefined();
      return new Response(new Uint8Array(String(input).endsWith("header") ? [1, 2] : [3, 4, 5, 6]));
    });
    const storage = new HttpCatalogStorageAdapter(await catalog(), { baseUrl: "/content/", fetch: fetcher });
    expect(await storage.readdir(".")).toEqual([{ name: "pack", isDir: true }]);
    expect(await storage.stat("pack/large.babasset")).toMatchObject({ size: 6 });
    expect(fetcher).not.toHaveBeenCalled();
    const header = await storage.readBinaryRange("pack/large.babasset", 0, 2);
    expect(header.bytes).toEqual(new Uint8Array([1, 2]));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/content/header", undefined);
    expect(storage.getReadMetrics()).toMatchObject({ actualBytesRead: 2, fullReads: 0 });
    const chunk = await storage.readBinaryRange("pack/large.babasset", 2, 4, header.revision);
    expect(chunk.bytes).toEqual(new Uint8Array([3, 4, 5, 6]));
    await expect(storage.readBinaryRange("pack/large.babasset", 0, 2, "old")).rejects.toThrow(/revision/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("validates HTTP ranges and rejects servers that return entire objects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([4, 5]), {
      status: 206, headers: { "Content-Range": "bytes 1-2/4", "Content-Length": "2" },
    })).mockResolvedValueOnce(new Response(new Uint8Array([3, 4, 5, 6]), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5]), { status: 206, headers: { "Content-Range": "bytes 0-1/4" } }));
    const storage = new HttpCatalogStorageAdapter(await catalog(), { baseUrl: "/", fetch: fetcher });
    expect((await storage.readBinaryRange("pack/large.babasset", 3, 2)).bytes).toEqual(new Uint8Array([4, 5]));
    expect(fetcher).toHaveBeenCalledWith("/payload", { headers: { Range: "bytes=1-2" } });
    await expect(storage.readBinaryRange("pack/large.babasset", 3, 2)).rejects.toThrow(/bounded HTTP/i);
    await expect(storage.readBinaryRange("pack/large.babasset", 3, 2)).rejects.toThrow(/bounded HTTP/i);
    expect(storage.getReadMetrics().actualBytesRead).toBe(2);
  });

  it("accepts browser-decoded full objects from compressed static hosting", async () => {
    const storage = new HttpCatalogStorageAdapter(await catalog(), {
      baseUrl: "/", fetch: async () => new Response(new Uint8Array([3, 4, 5, 6]), {
        headers: { "Content-Encoding": "gzip", "Content-Length": "24" },
      }),
    });
    expect((await storage.readBinaryRange("pack/large.babasset", 2, 4)).bytes).toEqual(new Uint8Array([3, 4, 5, 6]));
    expect(storage.getReadMetrics().actualBytesRead).toBe(4);
  });

  it.each([
    [[3, 4, 5], /truncated/i, 3],
    [[3, 4, 5, 6, 7], /exceeded/i, 5],
    [[7, 7, 7, 7], /hash mismatch/i, 4],
  ] as const)("rejects corrupt payload responses and accounts discarded bytes", async (bytes, error, actualBytesRead) => {
    const storage = new HttpCatalogStorageAdapter(await catalog(), {
      baseUrl: "/", fetch: async () => new Response(new Uint8Array(bytes)),
    });
    await expect(storage.readBinaryRange("pack/large.babasset", 2, 4)).rejects.toThrow(error);
    expect(storage.getReadMetrics().actualBytesRead).toBe(actualBytesRead);
  });
});

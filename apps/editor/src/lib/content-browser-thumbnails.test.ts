import { describe, expect, it, vi } from "vitest";
import {
  syncContentBrowserThumbnailUrls,
  type ThumbnailUrlMap,
} from "./content-browser-thumbnails";

describe("syncContentBrowserThumbnailUrls", () => {
  it("decodes only mounted Texture/Model cells and revokes URLs that leave the window", async () => {
    const load = vi.fn(async (guid: string) => new Uint8Array([guid.length]));
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const revokeObjectURL = vi.fn();
    let current: ThumbnailUrlMap = {};
    const commit = (next: ThumbnailUrlMap) => {
      current = next;
    };

    await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["a", "b"],
      urls: {},
      hidden: false,
      load,
      createObjectURL,
      revokeObjectURL,
      commit,
    });
    const first = current;

    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith("a");
    expect(load).toHaveBeenCalledWith("b");
    expect(Object.keys(first)).toEqual(["a", "b"]);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["b", "c"],
      urls: first,
      hidden: false,
      load,
      createObjectURL,
      revokeObjectURL,
      commit,
    });
    const second = current;

    expect(load).toHaveBeenCalledWith("c");
    expect(second).not.toHaveProperty("a");
    expect(second).toHaveProperty("b", first.b);
    expect(second).toHaveProperty("c");
    expect(revokeObjectURL).toHaveBeenCalledWith(first.a);
  });

  it("keeps loading the batch when one thumbnail read throws", async () => {
    const load = vi.fn(async (guid: string) => {
      if (guid === "broken") throw new Error("Thumbnail storage is unavailable");
      return new Uint8Array([1]);
    });
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}:${createObjectURL.mock.calls.length}`);
    const revokeObjectURL = vi.fn();
    const commit = vi.fn();

    await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["broken", "after"],
      urls: { broken: "blob:previous" },
      refreshGuids: new Set(["broken"]),
      hidden: false,
      load,
      createObjectURL,
      revokeObjectURL,
      commit,
    });

    expect(load.mock.calls).toEqual([["broken"], ["after"]]);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0]).toMatchObject({ broken: "blob:previous", after: expect.any(String) });
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("skips decode while the Content Browser is CSS-hidden", async () => {
    const load = vi.fn(async () => new Uint8Array([1]));
    const createObjectURL = vi.fn(() => "blob:new");
    const revokeObjectURL = vi.fn();
    const urls = { a: "blob:a" };
    const commit = vi.fn();

    await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["a", "b"],
      urls,
      hidden: true,
      load,
      createObjectURL,
      revokeObjectURL,
      commit,
    });

    expect(load).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps a committed batch and releases only the URLs of the batch it abandoned", async () => {
    let resolvePending!: (bytes: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((resolve) => {
      resolvePending = resolve;
    });
    let requestedPending!: () => void;
    const requested = new Promise<void>((resolve) => {
      requestedPending = resolve;
    });
    const load = vi.fn(async (guid: string) => {
      if (guid === "new") return new Uint8Array([1]);
      requestedPending();
      return pending;
    });
    const createObjectURL = vi.fn(() => "blob:new");
    const revokeObjectURL = vi.fn();
    const commit = vi.fn();
    let cancelled = false;
    const syncing = syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["borrowed", "new", "pending", "unrequested"],
      urls: { borrowed: "blob:borrowed", new: "blob:previous", old: "blob:old" },
      refreshGuids: new Set(["new"]),
      hidden: false,
      concurrency: 1,
      load,
      createObjectURL,
      revokeObjectURL,
      isCancelled: () => cancelled,
      commit,
    });
    await requested;
    cancelled = true;
    resolvePending(new Uint8Array([2]));
    await syncing;

    // "new" finished before the cancellation: its batch is committed, replaces
    // the previous image and drops the tile that left the window.
    expect(commit.mock.calls).toEqual([
      [{ borrowed: "blob:borrowed", new: "blob:new" }, { loaded: ["new"], done: false }],
    ]);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:old"], ["blob:previous"]]);
    // "pending" was in flight when the sync was cancelled: nothing is created
    // for it, and "unrequested" is never read.
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(load.mock.calls).toEqual([["new"], ["pending"]]);
  });

  it("reads a bounded number of thumbnails at once and commits each batch as it finishes", async () => {
    let inFlight = 0;
    let peak = 0;
    const load = vi.fn(async (guid: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Uint8Array([guid.charCodeAt(0)]);
    });
    let sequence = 0;
    const createObjectURL = vi.fn(() => `blob:${++sequence}`);
    const commits: Array<[string[], string[], boolean]> = [];

    await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["a", "b", "c", "d", "e"],
      urls: {},
      hidden: false,
      concurrency: 2,
      load,
      createObjectURL,
      revokeObjectURL: vi.fn(),
      commit: (urls, progress) => {
        commits.push([Object.keys(urls), [...progress.loaded], progress.done]);
      },
    });

    expect(peak).toBe(2);
    expect(commits).toEqual([
      [["a", "b"], ["a", "b"], false],
      [["a", "b", "c", "d"], ["c", "d"], false],
      [["a", "b", "c", "d", "e"], ["e"], true],
    ]);
  });

  it("still commits once to drop tiles that left the window when nothing needs loading", async () => {
    const load = vi.fn();
    const revokeObjectURL = vi.fn();
    const commit = vi.fn();

    await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["kept"],
      urls: { kept: "blob:kept", gone: "blob:gone" },
      hidden: false,
      load,
      createObjectURL: vi.fn(),
      revokeObjectURL,
      commit,
    });

    expect(load).not.toHaveBeenCalled();
    expect(commit.mock.calls).toEqual([[{ kept: "blob:kept" }, { loaded: [], done: true }]]);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:gone"]]);
  });

  it("hands replaced and evicted URLs to the host after the commit when it defers revocation", async () => {
    const events: string[] = [];

    await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["a"],
      urls: { a: "blob:a-old", gone: "blob:gone" },
      refreshGuids: new Set(["a"]),
      hidden: false,
      load: async () => new Uint8Array([1]),
      createObjectURL: () => "blob:a-new",
      revokeObjectURL: (url) => events.push(`revoke ${url}`),
      retireObjectURLs: (urls) => events.push(`retire ${urls.join(",")}`),
      commit: () => events.push("commit"),
    });

    // Nothing is revoked on the host's behalf: the tile may still show a dropped URL until the commit renders.
    expect(events).toEqual(["commit", "retire blob:gone,blob:a-old"]);
  });

  it("leaves a batch's URLs and the ones it replaced alone when its commit throws", async () => {
    const revokeObjectURL = vi.fn();
    const retireObjectURLs = vi.fn();

    await expect(
      syncContentBrowserThumbnailUrls({
        mountedTextureGuids: ["a"],
        urls: { gone: "blob:gone" },
        hidden: false,
        load: async () => new Uint8Array([1]),
        createObjectURL: () => "blob:a",
        revokeObjectURL,
        retireObjectURLs,
        commit: () => {
          throw new Error("render failed");
        },
      }),
    ).rejects.toThrow("render failed");

    // The commit may already show blob:a or blob:gone, so neither is revoked.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(retireObjectURLs).not.toHaveBeenCalled();
  });
});

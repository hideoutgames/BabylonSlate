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

  it("releases abandoned new URLs after a deferred load without revoking borrowed URLs", async () => {
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
      urls: { borrowed: "blob:borrowed", old: "blob:old" },
      hidden: false,
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

    expect(commit).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:new"]]);
    expect(load.mock.calls).toEqual([["new"], ["pending"]]);
  });
});

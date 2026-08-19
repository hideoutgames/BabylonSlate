import { describe, expect, it, vi } from "vitest";
import { syncContentBrowserThumbnailUrls } from "./content-browser-thumbnails";

describe("syncContentBrowserThumbnailUrls", () => {
  it("decodes only mounted Texture/Model cells and revokes URLs that leave the window", async () => {
    const load = vi.fn(async (guid: string) => new Uint8Array([guid.length]));
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const revokeObjectURL = vi.fn();

    const first = await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["a", "b"],
      urls: {},
      hidden: false,
      load,
      createObjectURL,
      revokeObjectURL,
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith("a");
    expect(load).toHaveBeenCalledWith("b");
    expect(Object.keys(first)).toEqual(["a", "b"]);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    const second = await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["b", "c"],
      urls: first,
      hidden: false,
      load,
      createObjectURL,
      revokeObjectURL,
    });

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

    const next = await syncContentBrowserThumbnailUrls({
      mountedTextureGuids: ["a", "b"],
      urls,
      hidden: true,
      load,
      createObjectURL,
      revokeObjectURL,
    });

    expect(load).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(next).toEqual(urls);
  });
});

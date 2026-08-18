import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectUiImageUrls,
  mimeForUiTexture,
  resolveUiImages,
  revokeUnreferencedUiImageUrls,
  uiImageIssueMessage,
  uiImageUrlsEqual,
} from "./play-ui-images";

function stubBlobUrls(): {
  created: string[];
  revoke: ReturnType<typeof vi.fn>;
} {
  const created: string[] = [];
  let next = 0;
  const revoke = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => {
      const url = `blob:${blob.type}:${next++}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: revoke,
  });
  return { created, revoke };
}

describe("collectUiImageUrls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds blob URLs from pixels with image MIME", async () => {
    const created: Array<{ bytes: Uint8Array; type: string }> = [];
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        created.push({ bytes: new Uint8Array(), type: blob.type });
        return `blob:${blob.type}`;
      },
      revokeObjectURL: vi.fn(),
    });
    const urls = await collectUiImageUrls(
      ["tex-1"],
      [
        {
          guid: "tex-1",
          path: "assets/Logo.texture.babasset",
          type: "Texture",
          chunks: [{ id: "pixels", mime: "image/jpeg" }],
        },
      ],
      async () => new Uint8Array([1, 2, 3]),
    );
    expect(urls.get("tex-1")).toBe("blob:image/jpeg");
    expect(created[0]?.type).toBe("image/jpeg");
  });

  it("reports a missing pixels/source chunk instead of silently skipping", async () => {
    const result = await resolveUiImages(
      ["tex-missing"],
      [
        {
          guid: "tex-missing",
          path: "assets/Gone.texture.babasset",
          type: "Texture",
          chunks: [],
        },
      ],
      async () => null,
    );
    expect(result.urls.size).toBe(0);
    expect(result.issues).toEqual([
      { guid: "tex-missing", reason: "missing-chunk" },
    ]);
  });

  it("reports an unresolved texture guid", async () => {
    const result = await resolveUiImages(["gone"], [], async () => null);
    expect(result.urls.size).toBe(0);
    expect(result.issues).toEqual([{ guid: "gone", reason: "missing-asset" }]);
  });

  it("falls back to the source chunk and png when MIME is missing", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => `blob:${blob.type}`,
      revokeObjectURL: vi.fn(),
    });
    const urls = await collectUiImageUrls(
      ["tex-2"],
      [{ guid: "tex-2", path: "assets/Icon.texture.babasset", type: "Texture" }],
      async (_path, chunkId) =>
        chunkId === "source" ? new Uint8Array([9]) : null,
    );
    expect(urls.get("tex-2")).toBe("blob:image/png");
  });

  it("reuses a previous blob URL for the same guid instead of creating another", async () => {
    const { created, revoke } = stubBlobUrls();
    const assets = [
      {
        guid: "tex-1",
        path: "assets/Logo.texture.babasset",
        type: "Texture",
        chunks: [{ id: "pixels", mime: "image/png" }],
      },
    ];
    const readChunk = async () => new Uint8Array([1, 2, 3]);
    const first = await collectUiImageUrls(["tex-1"], assets, readChunk);
    const reused = first.get("tex-1");
    expect(reused).toBeTruthy();
    expect(created).toHaveLength(1);

    const second = await collectUiImageUrls(["tex-1"], assets, readChunk, first);
    expect(second.get("tex-1")).toBe(reused);
    expect(created).toHaveLength(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(second).not.toBe(first);
  });

  it("revokes blob URLs that dropped out of the guid set", async () => {
    const { created, revoke } = stubBlobUrls();
    const assets = [
      {
        guid: "tex-1",
        path: "assets/Logo.texture.babasset",
        type: "Texture",
      },
      {
        guid: "tex-2",
        path: "assets/Icon.texture.babasset",
        type: "Texture",
      },
    ];
    const readChunk = async () => new Uint8Array([9]);
    const first = await collectUiImageUrls(["tex-1", "tex-2"], assets, readChunk);
    expect(created).toHaveLength(2);
    const dropped = first.get("tex-1");
    const kept = first.get("tex-2");

    const second = await collectUiImageUrls(["tex-2"], assets, readChunk, first);
    expect(second.get("tex-2")).toBe(kept);
    expect(second.has("tex-1")).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(dropped);
    expect(created).toHaveLength(2);
  });
});

describe("revokeUnreferencedUiImageUrls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revokes only URLs that are not still held by the keep map", () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: () => "unused",
      revokeObjectURL: revoke,
    });
    const keep = new Map([["tex-1", "blob:keep"]]);
    const candidate = new Map([
      ["tex-1", "blob:keep"],
      ["tex-2", "blob:new"],
    ]);
    revokeUnreferencedUiImageUrls(candidate, keep);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:new");
    expect(candidate.get("tex-1")).toBe("blob:keep");
    expect(candidate.has("tex-2")).toBe(false);
  });
});

describe("uiImageUrlsEqual", () => {
  it("is true when both maps hold the same guid URLs", () => {
    const left = new Map([["tex-1", "blob:a"]]);
    const right = new Map([["tex-1", "blob:a"]]);
    expect(uiImageUrlsEqual(left, right)).toBe(true);
    expect(uiImageUrlsEqual(left, new Map([["tex-1", "blob:b"]]))).toBe(false);
    expect(uiImageUrlsEqual(left, new Map())).toBe(false);
  });
});

describe("uiImageIssueMessage", () => {
  it("names the missing chunk or unresolved texture", () => {
    expect(uiImageIssueMessage({ guid: "tex-1", reason: "missing-chunk" })).toMatch(
      /chunk/i,
    );
    expect(uiImageIssueMessage({ guid: "gone", reason: "missing-asset" })).toMatch(
      /missing/i,
    );
  });
});

describe("mimeForUiTexture", () => {
  it("prefers an image/* chunk MIME over a generic fallback", () => {
    expect(mimeForUiTexture("image/webp")).toBe("image/webp");
    expect(mimeForUiTexture("application/octet-stream")).toBe("image/png");
  });
});

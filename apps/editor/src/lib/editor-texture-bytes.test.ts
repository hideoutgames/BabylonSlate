import { describe, expect, it, vi } from "vitest";
import {
  loadEditorTextureBytes,
  type EditorTextureByteService,
} from "./editor-texture-bytes";

function pngBytes(width = 8, height = 8): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function ktx2Bytes(): Uint8Array {
  const bytes = new Uint8Array(28);
  bytes.set(
    [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a],
    0,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(20, 512, true);
  view.setUint32(24, 512, true);
  return bytes;
}

function makeService(
  best: { kind: "ktx2" | "pixels" | "source"; bytes: Uint8Array } | null,
): EditorTextureByteService & { readAssetChunk: ReturnType<typeof vi.fn> } {
  return {
    readBestTextureChunk: vi.fn(async () =>
      best ? { ...best, mime: undefined, clampedByLod: false } : null,
    ),
    readAssetChunk: vi.fn(async (_path: string, chunkId: string) => {
      if (chunkId === "pixels") return pngBytes();
      if (chunkId === "source") return pngBytes(4, 4);
      return null;
    }),
  };
}

const ASSET = {
  path: "assets/Tex.babasset",
  guid: "tex-guid",
  payload: { usage: "albedo" },
};

describe("loadEditorTextureBytes", () => {
  it("engine surface prefers KTX2 variant bytes", async () => {
    const service = makeService({ kind: "ktx2", bytes: ktx2Bytes() });
    const out = await loadEditorTextureBytes(service, ASSET, { surface: "engine" });
    expect(out?.byteLength).toBe(ktx2Bytes().byteLength);
    expect(service.readBestTextureChunk).toHaveBeenCalled();
  });

  it("dom surface never returns KTX2 — falls back to raw pixels", async () => {
    const service = makeService({ kind: "ktx2", bytes: ktx2Bytes() });
    const out = await loadEditorTextureBytes(service, ASSET, { surface: "dom" });
    expect(out?.byteLength).toBe(pngBytes().byteLength);
    expect(service.readAssetChunk).toHaveBeenCalledWith("assets/Tex.babasset", "pixels");
  });

  it("falls back to source when neither variant nor pixels exist (dom)", async () => {
    const service: EditorTextureByteService = {
      readBestTextureChunk: vi.fn(async () => null),
      readAssetChunk: vi.fn(async (_p, id) => (id === "source" ? pngBytes(3, 3) : null)),
    };
    const out = await loadEditorTextureBytes(service, ASSET, { surface: "dom" });
    expect(out?.byteLength).toBe(pngBytes(3, 3).byteLength);
  });

  it("returns null when nothing anywhere has bytes (engine)", async () => {
    const service: EditorTextureByteService = {
      readBestTextureChunk: vi.fn(async () => null),
      readAssetChunk: vi.fn(async () => null),
    };
    expect(await loadEditorTextureBytes(service, ASSET, { surface: "engine" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { encodeAssetDocument, readAssetDocumentHeader, type ChunkEntry, type IndexedAsset } from "@babylonslate/assets";
import { changedTextureEncodings, sceneViewportAssetKey, sceneViewportTextureEncodings } from "./scene-viewport-assets";

function chunk(id: string, kind: string, sha256: string): ChunkEntry {
  return { id, kind, mime: "application/octet-stream", sha256, byteLength: 4, locator: { inline: { offset: 0, length: 4 } } };
}

async function indexed(type: string, guid: string, payload: Record<string, unknown>, chunks: ChunkEntry[]): Promise<IndexedAsset> {
  const header = readAssetDocumentHeader(await encodeAssetDocument({ type, guid, name: guid, version: 1, payload }));
  return { rootId: "project", path: `assets/${guid}.babasset`, header: { ...header, payload, chunks } };
}

const sourceChunk = (sha: string) => chunk("pixels", "pixels", sha);
const ktx2Chunk = (sha: string) => chunk("ktx2:abc", "ktx2", sha);

describe("viewport Texture keys", () => {
  it("stay equal through encode progress and a committed KTX2, and change for a reimport or a setting", async () => {
    const queued = await indexed("Texture", "tex", { usage: "albedo", compressionState: "pending" }, [sourceChunk("a")]);
    const key = (asset: IndexedAsset) => sceneViewportAssetKey(null, [asset]);
    const before = key(queued);

    const encoding = await indexed("Texture", "tex", { usage: "albedo", compressionState: "encoding" }, [sourceChunk("a")]);
    const failed = await indexed("Texture", "tex", { usage: "albedo", compressionState: "encode_failed", encodeError: "boom" }, [sourceChunk("a")]);
    const committed = await indexed("Texture", "tex", {
      usage: "albedo", compressionState: "compressed", encodeWallMs: 40, ktx2ChunkId: "ktx2:abc",
      ktx2Width: 4, ktx2Height: 4, ktx2BlockAlign: 4, ktx2Sha256: "k",
    }, [sourceChunk("a"), ktx2Chunk("k")]);
    expect([encoding, failed, committed].map(key)).toEqual([before, before, before]);

    const reimported = await indexed("Texture", "tex", { usage: "albedo", compressionState: "pending" }, [sourceChunk("b")]);
    const retuned = await indexed("Texture", "tex", { usage: "normal", compressionState: "pending" }, [sourceChunk("a")]);
    expect(key(reimported)).not.toBe(before);
    expect(key(retuned)).not.toBe(before);
  });

  it("still follow every payload field of other resources", async () => {
    const material = (compressionState: string) => indexed("Material", "mat", { compressionState }, []);
    const key = (asset: IndexedAsset) => sceneViewportAssetKey(null, [asset]);
    expect(key(await material("a"))).not.toBe(key(await material("b")));
  });
});

describe("viewport Texture encodings", () => {
  it("name only the installed Textures whose stored encoding changed", async () => {
    const source = await indexed("Texture", "tex", { compressionState: "pending" }, [sourceChunk("a")]);
    const other = await indexed("Texture", "other", { compressionState: "pending" }, [sourceChunk("c")]);
    const unused = await indexed("Texture", "unused", { compressionState: "pending" }, [sourceChunk("d")]);
    const applied = sceneViewportTextureEncodings([source, other]);

    // Progress rewrites the header without changing how the Texture is stored.
    const encoding = await indexed("Texture", "tex", { compressionState: "encoding" }, [sourceChunk("a")]);
    expect(changedTextureEncodings(applied, sceneViewportTextureEncodings([encoding, other, unused]))).toEqual([]);

    const committed = await indexed("Texture", "tex", { compressionState: "compressed", ktx2ChunkId: "ktx2:abc" }, [sourceChunk("a"), ktx2Chunk("k")]);
    const unusedCommit = await indexed("Texture", "unused", { compressionState: "compressed", ktx2ChunkId: "ktx2:abc" }, [sourceChunk("d"), ktx2Chunk("k")]);
    expect(changedTextureEncodings(applied, sceneViewportTextureEncodings([committed, other, unusedCommit]))).toEqual(["tex"]);
  });
});

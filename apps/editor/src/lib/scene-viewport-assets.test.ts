import { describe, expect, it } from "vitest";
import { encodeAssetDocument, readAssetDocumentHeader, type ChunkEntry, type IndexedAsset } from "@haptic/assets";
import {
  changedTextureEncodings,
  sceneViewportAssetKey,
  sceneViewportTextureEncodings,
  stableViewportPayloadRevisions,
  viewportPayloadRevisions,
} from "./scene-viewport-assets";

function chunk(id: string, kind: string, sha256: string): ChunkEntry {
  return { id, kind, mime: "application/octet-stream", sha256, byteLength: 4, locator: { inline: { offset: 0, length: 4 } } };
}

async function indexed(type: string, guid: string, payload: Record<string, unknown>, chunks: ChunkEntry[]): Promise<IndexedAsset> {
  const header = readAssetDocumentHeader(await encodeAssetDocument({ type, guid, name: guid, version: 1, payload }));
  return { rootId: "project", path: `assets/${guid}.hasset`, header: { ...header, payload, chunks } };
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

describe("viewport resource key", () => {
  it("lists every resource by guid with its payload and chunks, and a Texture without its encode bookkeeping", async () => {
    const material = await indexed("Material", "mat", { value: 1 }, []);
    const texture = await indexed("Texture", "tex", { usage: "albedo", compressionState: "pending" }, [sourceChunk("a")]);
    const sprite = await indexed("Sprite", "sprite", {}, [chunk("frames", "frames", "f")]);
    const resources = sceneViewportAssetKey(null, [texture, material, sprite]).split("\n")[1];
    expect(resources).toBe(
      '[["mat","Material",{"value":1},[]],["sprite","Sprite",{},[["frames","f"]]],["tex","Texture",[["usage","albedo"]],["pixels:a"]]]',
    );
  });

  it("serializes a resource whose header did not change once, however often the others change", async () => {
    let serialized = 0;
    const saved = await indexed("Material", "stable", {}, []);
    const stable: IndexedAsset = {
      ...saved,
      header: { ...saved.header, payload: { toJSON: () => { serialized += 1; return { graph: 1 }; } } },
    };
    const key = async (value: number) => sceneViewportAssetKey(null, [stable, await indexed("Material", "other", { value }, [])]);

    const first = await key(1);
    const second = await key(2);
    expect(second).not.toBe(first);
    expect(second).toContain('["stable","Material",{"graph":1},[]]');
    expect(second).toContain('["other","Material",{"value":2},[]]');
    expect(serialized).toBe(1);
  });
});

describe("viewport payload revisions", () => {
  it("follow the saved header, or the open document that collection prefers", async () => {
    const map = await indexed("Tilemap", "map", { layers: 1 }, []);
    const water = await indexed("Water", "water", {}, []);
    const material = await indexed("Material", "mat", {}, []);
    const saved = viewportPayloadRevisions([map, water, material], []);
    expect([...saved.keys()].sort()).toEqual(["map", "water"]);
    expect(viewportPayloadRevisions([material, water, map], [])).toEqual(saved);

    const edited = await indexed("Tilemap", "map", { layers: 2 }, []);
    expect(viewportPayloadRevisions([edited], []).get("map")).not.toBe(saved.get("map"));

    const tab = (content: unknown) => [{ ref: { kind: "tilemap", path: map.path }, content }];
    const content = { layers: 3 };
    const open = viewportPayloadRevisions([map], tab(content)).get("map");
    expect(open).not.toBe(saved.get("map"));
    expect(viewportPayloadRevisions([map], tab(content)).get("map")).toBe(open);
    expect(viewportPayloadRevisions([map], tab({ layers: 4 })).get("map")).not.toBe(open);
    // A tab with nothing loaded yet leaves collection reading the saved asset.
    expect(viewportPayloadRevisions([map], tab(null)).get("map")).toBe(saved.get("map"));
    // A tab holding something that is not a document gives no revision to remember.
    expect(viewportPayloadRevisions([map], tab("text")).has("map")).toBe(false);
  });

  it("keep only the revisions that did not move across a collection", () => {
    const before = new Map([["a", "1"], ["b", "1"], ["gone", "1"]]);
    const after = new Map([["a", "1"], ["b", "2"], ["new", "1"]]);
    expect(stableViewportPayloadRevisions(before, after)).toEqual(new Map([["a", "1"]]));
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

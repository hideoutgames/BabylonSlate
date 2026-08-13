import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  decodeAssetDocument,
  DOCUMENT_CHUNK_ID,
  encodeAssetDocument,
  extraChunksFromDecoded,
  isAssetDocumentPath,
  readAssetDocumentHeader,
} from "./asset-document";
import { createMemoryBlobStore, createVfsBlobStore } from "./blob-store";
import { decodeBabasset, encodeBabasset } from "./babasset";
import { BLOBS_DIR } from "./babproject";
import { sha256Hex } from "./bytes";

const scene = {
  type: "Scene",
  name: "main.scene",
  guid: "scene-guid",
  version: 1,
  payload: { meshes: [{ id: "cube", type: "box", position: [0, 0, 0] }] },
};

describe("asset documents", () => {
  it("round-trips an editor document through .babasset", async () => {
    const bytes = await encodeAssetDocument(scene);
    const decoded = await decodeAssetDocument(bytes);
    expect(decoded).toEqual(scene);
  });

  it("reads type and version from the header without decoding chunks", async () => {
    const bytes = await encodeAssetDocument(scene);
    const header = readAssetDocumentHeader(bytes);
    expect(header.type).toBe("Scene");
    expect(header.version).toBe(1);
    expect(header.chunks.map((c) => c.id)).toEqual([DOCUMENT_CHUNK_ID]);
  });

  it("encodes deterministically for identical payloads", async () => {
    const a = await encodeAssetDocument(scene);
    const b = await encodeAssetDocument({
      ...scene,
      payload: { meshes: scene.payload.meshes },
    });
    expect(a).toEqual(b);
  });

  it("rejects assets without a document chunk or header payload", async () => {
    const bytes = await encodeBabasset({
      header: {
        guid: "font-1",
        type: "Font",
        name: "Ui",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: {},
      },
      chunks: [
        {
          id: "source",
          kind: "font",
          mime: "font/woff2",
          data: new Uint8Array([1, 2, 3]),
        },
      ],
    });
    await expect(decodeAssetDocument(bytes)).rejects.toThrow(
      /header payload/,
    );
  });

  it("opens imported assets that store payload in the header (no document chunk)", async () => {
    const bytes = await encodeBabasset({
      header: {
        guid: "font-1",
        type: "Font",
        name: "Ui",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { family: "Ui", weight: 400, style: "normal" },
      },
      chunks: [
        {
          id: "source",
          kind: "font",
          mime: "font/woff2",
          data: new Uint8Array([10, 11, 12]),
        },
      ],
    });
    const decoded = await decodeAssetDocument(bytes);
    expect(decoded.payload.family).toBe("Ui");
    expect(decoded.guid).toBe("font-1");
  });

  it("keeps non-document chunks when re-encoding an imported font", async () => {
    const source = new Uint8Array([10, 11, 12]);
    const imported = await encodeBabasset({
      header: {
        guid: "font-1",
        type: "Font",
        name: "Ui",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        parentClass: null,
        payload: { family: "Ui" },
      },
      chunks: [
        { id: "source", kind: "font", mime: "font/woff2", data: source },
      ],
    });
    const decoded = await decodeBabasset(imported);
    const extra = extraChunksFromDecoded(decoded);
    expect(extra).toHaveLength(1);
    expect(extra[0]!.id).toBe("source");

    const saved = await encodeAssetDocument(
      {
        type: "Font",
        name: "Ui",
        guid: "font-1",
        version: 1,
        payload: { family: "Ui Display" },
      },
      { extraChunks: extra },
    );
    const roundTrip = await decodeBabasset(saved);
    expect(roundTrip.chunks.get("source")).toEqual(source);
    const document = await decodeAssetDocument(saved);
    expect(document.payload.family).toBe("Ui Display");
  });

  it("externalises large chunks to the blob store and reads them back", async () => {
    const big = "x".repeat(100 * 1024);
    const blobs = createMemoryBlobStore();
    const bytes = await encodeAssetDocument(
      { ...scene, payload: { notes: big } },
      { blobs },
    );
    const header = readAssetDocumentHeader(bytes);
    expect(header.chunks[0]!.locator).toHaveProperty("blob");
    expect(await blobs.hasBlob(header.chunks[0]!.sha256)).toBe(true);

    const decoded = await decodeAssetDocument(bytes, { blobs });
    expect(decoded.payload.notes).toBe(big);
  });

  it("recognises asset document paths", () => {
    expect(isAssetDocumentPath("assets/main.scene.babasset")).toBe(true);
    expect(isAssetDocumentPath("scenes/main.scene.json")).toBe(false);
  });
});

describe("vfs blob store", () => {
  async function boundStorage() {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Blobs.babproject");
    return storage;
  }

  it("writes content-addressed blobs under assets/.blobs", async () => {
    const storage = await boundStorage();
    const blobs = createVfsBlobStore(storage);
    const data = new Uint8Array([1, 2, 3]);
    const hash = await sha256Hex(data);

    await blobs.writeBlob(hash, data);
    expect(await storage.exists(`${BLOBS_DIR}/${hash}`)).toBe(true);
    expect(await blobs.readBlob(hash)).toEqual(data);
    expect(await blobs.hasBlob(hash)).toBe(true);
  });

  it("treats blobs as immutable and never rewrites an existing hash", async () => {
    const storage = await boundStorage();
    const blobs = createVfsBlobStore(storage);
    const data = new Uint8Array([9, 9]);
    const hash = await sha256Hex(data);

    await blobs.writeBlob(hash, data);
    await blobs.writeBlob(hash, new Uint8Array([7]));
    expect(await blobs.readBlob(hash)).toEqual(data);
  });

  it("reports missing blobs", async () => {
    const blobs = createMemoryBlobStore();
    await expect(blobs.readBlob("nope")).rejects.toThrow(/Blob not found/);
  });

  it("keeps unchanged large chunks out of a re-save", async () => {
    const storage = await boundStorage();
    const blobs = createVfsBlobStore(storage);
    const payload = { notes: "y".repeat(100 * 1024) };
    const writeBinary = vi.spyOn(storage, "writeBinary");

    await encodeAssetDocument({ ...scene, payload }, { blobs });
    const afterFirst = writeBinary.mock.calls.length;
    await encodeAssetDocument({ ...scene, payload }, { blobs });

    // Second save re-hashes but writes no blob bytes: the §19 mitigation that
    // keeps large immutable chunks out of every save.
    expect(writeBinary.mock.calls.length).toBe(afterFirst);
  });
});

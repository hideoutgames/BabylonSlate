import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  HASSET_FORMAT_VERSION,
  HASSET_MAGIC,
  decodeHasset,
  encodeHasset,
  readHassetHeader,
  type HassetHeader,
} from "./hasset";
import { bytesEqual, concatBytes, sha256Hex, writeU32LE } from "./bytes";
import { AssetFormatVersionError, createDefaultMigrationRegistry } from "./migration";

/** A file with an arbitrary header, as another writer could have stored it. */
function rawHasset(header: object, body: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  return concatBytes([HASSET_MAGIC, writeU32LE(HASSET_FORMAT_VERSION), writeU32LE(json.byteLength), json, body]);
}

describe("hasset codec", () => {
  it("round-trips header and inline chunks", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [], requiredVariableNames: [],
        guid: "guid-1",
        type: "Class",
        name: "Main",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        payload: { nodes: [], edges: [] },
      },
      chunks: [
        {
          id: "source",
          kind: "json",
          mime: "application/json",
          data: payload,
        },
      ],
      blobThreshold: 1024 * 1024,
    });

    const header = readHassetHeader(bytes);
    expect(header.guid).toBe("guid-1");
    expect(header.chunks).toHaveLength(1);
    expect("inline" in header.chunks[0]!.locator).toBe(true);

    const decoded = await decodeHasset(bytes);
    expect(bytesEqual(decoded.chunks.get("source")!, payload)).toBe(true);
  });

  it("refuses the older layout without chunk lengths or dependency metadata", async () => {
    const body = new TextEncoder().encode('{"name":"Old"}');
    const current: HassetHeader = {
      chunks: [{
        id: "document", kind: "document", mime: "application/json", sha256: await sha256Hex(body),
        byteLength: body.byteLength, locator: { inline: { offset: 0, length: body.byteLength } },
      }],
      dependencies: [], dependencyMetadataVersion: 1, requiredDependencies: [],
      engineVersion: "0.0.0", guid: "old-scene", mode: "thin", name: "Old", payload: {}, type: "Scene", version: 4,
    };
    expect((await decodeHasset(rawHasset(current, body))).chunks.get("document")).toEqual(body);

    const withoutMetadata: Record<string, unknown> = { ...current };
    delete withoutMetadata.dependencyMetadataVersion;
    delete withoutMetadata.requiredDependencies;
    const withoutLengths = { ...current, chunks: current.chunks.map((chunk) => {
      const old: Record<string, unknown> = { ...chunk };
      delete old.byteLength;
      return old;
    }) };
    for (const header of [withoutMetadata, withoutLengths]) {
      expect(() => readHassetHeader(rawHasset(header, body))).toThrow(AssetFormatVersionError);
      await expect(decodeHasset(rawHasset(header, body))).rejects.toThrow(
        /Asset old-scene uses an unsupported old \.hasset layout .*older files are not upgraded/,
      );
    }
    expect(() => readHassetHeader(rawHasset({ ...current, dependencyMetadataVersion: 2 }, body)))
      .toThrow(/newer engine version/);
    // A writer cannot produce a file the reader refuses.
    const header = { ...withoutMetadata };
    delete header.chunks;
    await expect(encodeHasset({ header: header as HassetHeader, chunks: [] })).rejects.toThrow(AssetFormatVersionError);
  });

  it("externalises large chunks to the blob store", async () => {
    const blobs = new Map<string, Uint8Array>();
    const big = new Uint8Array(70 * 1024).map((_, i) => i % 256);
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "g2",
        type: "Texture",
        name: "Big",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        payload: {},
      },
      chunks: [
        { id: "pixels", kind: "pixels", mime: "application/octet-stream", data: big },
      ],
      blobThreshold: 64 * 1024,
      writeBlob: async (hash, data) => {
        blobs.set(hash, data);
      },
    });

    const header = readHassetHeader(bytes);
    expect("blob" in header.chunks[0]!.locator).toBe(true);
    const hash = await sha256Hex(big);
    expect(blobs.get(hash)?.byteLength).toBe(big.byteLength);

    const decoded = await decodeHasset(bytes, async (h) => {
      const data = blobs.get(h);
      if (!data) throw new Error("missing blob");
      return data;
    });
    expect(bytesEqual(decoded.chunks.get("pixels")!, big)).toBe(true);
  });

  it("rejects a truncated inline chunk and a torn blob instead of returning short bytes", async () => {
    const header = {
      guid: "g4",
      type: "Texture",
      name: "Torn",
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin" as const,
      dependencies: [],
      dependencyMetadataVersion: 1,
      requiredDependencies: [],
      payload: {},
    };
    const inline = await encodeHasset({
      header,
      chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: new Uint8Array([1, 2, 3, 4]) }],
      blobThreshold: 1024,
    });
    await expect(decodeHasset(inline.subarray(0, inline.byteLength - 2))).rejects.toThrow(/pixels/);

    const big = new Uint8Array(70 * 1024).map((_, i) => i % 251);
    const blobs = new Map<string, Uint8Array>();
    const thin = await encodeHasset({
      header,
      chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: big }],
      writeBlob: async (hash, data) => { blobs.set(hash, data); },
    });
    const [hash] = [...blobs.keys()];
    const torn = big.slice();
    torn.fill(0, 1024);
    await expect(decodeHasset(thin, async () => big.subarray(0, 1024))).rejects.toThrow(/Length mismatch/);
    await expect(decodeHasset(thin, async () => torn)).rejects.toThrow(/Hash mismatch/);
    expect(hash).toBe(await sha256Hex(big));
  });

  it("header-only read does not require chunk payload access", async () => {
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "g3",
        type: "Scene",
        name: "S",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: ["other"],
        payload: { meshes: [] },
      },
      chunks: [
        {
          id: "mesh",
          kind: "mesh",
          mime: "application/octet-stream",
          data: new Uint8Array([9, 9, 9]),
        },
      ],
    });
    const header = readHassetHeader(bytes);
    expect(header.dependencies).toEqual(["other"]);
    expect(header.chunks[0]?.sha256.length).toBe(64);
  });

  it("property: encode then decode preserves chunk bytes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 64 }), async (data) => {
        const bytes = await encodeHasset({
          header: {
            dependencyMetadataVersion: 1, requiredDependencies: [], requiredVariableNames: [],
            guid: "p",
            type: "Class",
            name: "P",
            engineVersion: "0.0.0",
            version: 1,
            mode: "thin",
            dependencies: [],
            payload: {},
          },
          chunks: [
            {
              id: "c",
              kind: "bin",
              mime: "application/octet-stream",
              data,
            },
          ],
          blobThreshold: 1024 * 1024,
        });
        const decoded = await decodeHasset(bytes);
        return bytesEqual(decoded.chunks.get("c")!, data);
      }),
      { numRuns: 25 },
    );
  });

  it("bundles nested dependency assets and unpacks them on decode", async () => {
    const nested = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "dep-1",
        type: "Texture",
        name: "Tex",
        engineVersion: "0.0.0",
        version: 1,
        mode: "thin",
        dependencies: [],
        payload: {},
      },
      chunks: [
        {
          id: "pixels",
          kind: "pixels",
          mime: "application/octet-stream",
          data: new Uint8Array([7, 7, 7]),
        },
      ],
      blobThreshold: 1024 * 1024,
    });

    const bundled = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [],
        guid: "root",
        type: "Material",
        name: "Mat",
        engineVersion: "0.0.0",
        version: 1,
        mode: "bundled",
        dependencies: ["dep-1"],
        payload: {},
      },
      chunks: [],
      nestedAssets: [{ guid: "dep-1", bytes: nested }],
    });

    const header = readHassetHeader(bundled);
    expect(header.mode).toBe("bundled");
    const decoded = await decodeHasset(bundled);
    expect(decoded.nestedAssets.get("dep-1")).toEqual(nested);
  });
});

describe("schema migration", () => {
  it("refuses future versions", () => {
    const registry = createDefaultMigrationRegistry();
    expect(() => registry.migrate("Class", 99, {})).toThrow(/newer engine version/);
  });

  it("passes through types that have no migration chain", () => {
    const registry = createDefaultMigrationRegistry();
    const result = registry.migrate("Texture", 1, { name: "Icon" });
    expect(result.migrated).toBe(false);
    expect(result.version).toBe(1);
    expect(result.payload).toEqual({ name: "Icon" });
  });
});

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  decodeBabasset,
  encodeBabasset,
  readBabassetHeader,
} from "./babasset";
import { bytesEqual, sha256Hex } from "./bytes";
import { createDefaultMigrationRegistry } from "./migration";

describe("babasset codec", () => {
  it("round-trips header and inline chunks", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const bytes = await encodeBabasset({
      header: {
        guid: "guid-1",
        type: "Graph",
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

    const header = readBabassetHeader(bytes);
    expect(header.guid).toBe("guid-1");
    expect(header.chunks).toHaveLength(1);
    expect("inline" in header.chunks[0]!.locator).toBe(true);

    const decoded = await decodeBabasset(bytes);
    expect(bytesEqual(decoded.chunks.get("source")!, payload)).toBe(true);
  });

  it("externalises large chunks to the blob store", async () => {
    const blobs = new Map<string, Uint8Array>();
    const big = new Uint8Array(70 * 1024).map((_, i) => i % 256);
    const bytes = await encodeBabasset({
      header: {
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

    const header = readBabassetHeader(bytes);
    expect("blob" in header.chunks[0]!.locator).toBe(true);
    const hash = await sha256Hex(big);
    expect(blobs.get(hash)?.byteLength).toBe(big.byteLength);

    const decoded = await decodeBabasset(bytes, async (h) => {
      const data = blobs.get(h);
      if (!data) throw new Error("missing blob");
      return data;
    });
    expect(bytesEqual(decoded.chunks.get("pixels")!, big)).toBe(true);
  });

  it("header-only read does not require chunk payload access", async () => {
    const bytes = await encodeBabasset({
      header: {
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
    const header = readBabassetHeader(bytes);
    expect(header.dependencies).toEqual(["other"]);
    expect(header.chunks[0]?.sha256.length).toBe(64);
  });

  it("property: encode then decode preserves chunk bytes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 64 }), async (data) => {
        const bytes = await encodeBabasset({
          header: {
            guid: "p",
            type: "Graph",
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
        const decoded = await decodeBabasset(bytes);
        return bytesEqual(decoded.chunks.get("c")!, data);
      }),
      { numRuns: 25 },
    );
  });

  it("bundles nested dependency assets and unpacks them on decode", async () => {
    const nested = await encodeBabasset({
      header: {
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

    const bundled = await encodeBabasset({
      header: {
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

    const header = readBabassetHeader(bundled);
    expect(header.mode).toBe("bundled");
    const decoded = await decodeBabasset(bundled);
    expect(decoded.nestedAssets.get("dep-1")).toEqual(nested);
  });
});

describe("schema migration", () => {
  it("migrates Graph v0 to v1", () => {
    const registry = createDefaultMigrationRegistry();
    const result = registry.migrate("Graph", 0, {});
    expect(result.migrated).toBe(true);
    expect(result.version).toBe(1);
    expect(result.payload.nodes).toEqual([]);
  });

  it("refuses future versions", () => {
    const registry = createDefaultMigrationRegistry();
    expect(() => registry.migrate("Graph", 99, {})).toThrow(/newer engine version/);
  });
});

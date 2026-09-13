import { describe, expect, it } from "vitest";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit/environment-fixtures";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { readEnvironmentTextureInfo } from "./environment-texture";
import { importByExtension } from "./importers";
import { AssetRegistry } from "./registry";
import { projectContentRoot } from "./content-root";
import { decodeBabasset, encodeBabasset } from "./babasset";
import { selectTextureChunk } from "./texture-loader";
import { resolveGpuTexture } from "./resolve-gpu-texture";

// Numeric 1×1 PNG; the container stores six independent face ranges.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
function env(manifestPatch: Record<string, unknown> = {}) {
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 2,
      width: 1,
      imageType: "image/png",
      specular: {
        mipmaps: Array.from({ length: 6 }, (_, face) => ({
          position: face * png.length,
          length: png.length,
        })),
      },
      ...manifestPatch,
    }),
  );
  const bytes = new Uint8Array(9 + header.length + png.length * 6);
  bytes.set([0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]);
  bytes.set(header, 8);
  for (let face = 0; face < 6; face++)
    bytes.set(png, header.length + 9 + face * png.length);
  return bytes;
}

describe("environment texture import", () => {
  it.each([false, true])(
    "retains a linear float DDS and all roughness mips through packaging (DX10=%s)",
    async (dx10) => {
      const source = buildFloatDdsCubeFixture({ dx10 });
      const [asset] = await importByExtension("Studio.dds", source, {
        fileName: "Studio.dds",
        existingGuids: new Set(),
      });
      expect(asset).toMatchObject({
        type: "Texture",
        name: "Studio",
        dependencies: [],
        payload: {
          dimension: "cube",
          container: "dds",
          encoding: "linearFloat32",
          width: 2,
          height: 2,
          mipLevels: 2,
          prefiltered: true,
          usage: "skybox",
        },
      });
      const packed = await encodeBabasset({
        header: { ...asset!, engineVersion: "0.0.0", mode: "thin" },
        chunks: asset!.chunks,
      });
      const decoded = await decodeBabasset(packed);
      expect(decoded.chunks.get("source")).toEqual(source);
      // Saved 2D settings or a stale encode must never reinterpret HDR cube data.
      decoded.header.payload = {
        ...decoded.header.payload,
        usage: "albedo",
        downsample: 16,
        ktx2ChunkId: "ktx2:stale",
      };
      decoded.header.chunks.push({
        ...decoded.header.chunks[0]!,
        id: "ktx2:stale",
        kind: "ktx2",
      });
      expect(
        selectTextureChunk(decoded.header, { transcoderAvailable: false }).chunk
          .id,
      ).toBe("source");
      expect(
        await resolveGpuTexture({
          header: decoded.header,
          readChunk: async (id) => decoded.chunks.get(id) ?? null,
          editorLod: { enabled: true, quality: 0.1 },
        }),
      ).toMatchObject({
        bytes: source,
        kind: "source",
        sourceEdge: 2,
        targetEdge: 2,
        missingPreferred: false,
      });
    },
  );

  it("imports RGBD ENV and validates the version, six faces, ranges, mip dimensions and irradiance", async () => {
    const source = env();
    const [asset] = await importByExtension("Studio.env", source, {
      fileName: "Studio.env",
      existingGuids: new Set(),
    });
    expect(asset!.payload).toMatchObject({
      dimension: "cube",
      encoding: "rgbd",
      width: 1,
      mipLevels: 1,
      hasIrradiance: false,
    });
    expect(asset!.chunks[0]!.data).toEqual(source);
    expect(() => readEnvironmentTextureInfo(env({ version: 3 }))).toThrow(
      /version/,
    );
    expect(() => readEnvironmentTextureInfo(env({ width: 2 }))).toThrow(
      /six faces/,
    );
    expect(() =>
      readEnvironmentTextureInfo(
        env({
          specular: {
            mipmaps: Array.from({ length: 6 }, () => ({
              position: 0,
              length: png.length,
            })),
          },
        }),
      ),
    ).toThrow(/overlap/);
    expect(() =>
      readEnvironmentTextureInfo(source.subarray(0, source.length - 1)),
    ).toThrow(/bounds/);
    expect(() =>
      readEnvironmentTextureInfo(env({ irradiance: { x: [1, 2, null] } })),
    ).toThrow(/irradiance/);
  });

  it("rejects non-cubes, incomplete mip chains, ambiguous encodings and truncated DDS", () => {
    for (const [offset, value, message] of [
      [12, 4, /square/],
      [112, 0x200, /six faces/],
      [28, 1, /complete mip/],
      [84, 0x31545844, /linear RGBA/],
      [80, 0x44, /linear RGBA/],
    ] as const) {
      const source = buildFloatDdsCubeFixture();
      new DataView(source.buffer).setUint32(offset, value, true);
      expect(() => readEnvironmentTextureInfo(source)).toThrow(message);
    }
    expect(() =>
      readEnvironmentTextureInfo(buildFloatDdsCubeFixture().subarray(0, 600)),
    ).toThrow(/truncated/);
    expect(
      readEnvironmentTextureInfo(
        buildFloatDdsCubeFixture({ halfFloat: true, dx10: true }),
      ).encoding,
    ).toBe("linearFloat16");
    const array = buildFloatDdsCubeFixture({ dx10: true });
    new DataView(array.buffer).setUint32(140, 2, true);
    expect(() => readEnvironmentTextureInfo(array)).toThrow(/arrays/);
  });

  it("retains source and dimensional metadata through registry rename and fresh indexing", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Environment.babproject");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const source = buildFloatDdsCubeFixture();
    const [asset] = await registry.importFile(
      "project",
      "",
      "Studio.dds",
      source,
    );
    const renamed = await registry.renameAsset(asset!.header.guid, "Renamed");
    const reopened = new AssetRegistry(storage);
    await reopened.mountRoot(projectContentRoot());
    expect(
      reopened.getByGuid(asset!.header.guid)?.header.payload,
    ).toMatchObject({
      dimension: "cube",
      encoding: "linearFloat32",
      mipLevels: 2,
    });
    expect(
      (await decodeBabasset(await storage.readBinary(renamed.path))).chunks.get(
        "source",
      ),
    ).toEqual(source);
  });
});

import { describe, expect, it } from "vitest";
import { emptySkyboxFaces } from "@babylonslate/core";
import { SKYBOX_FACE_KEYS } from "@babylonslate/core";
import {
  readTextureImageBytes,
  writeSkyboxCreatorFaceAssets,
} from "./skybox-creator-create";

function atlasRgba(): Uint8Array {
  const rgba = new Uint8Array(4 * 3 * 4);
  const put = (x: number, y: number, color: readonly [number, number, number, number]) => {
    rgba.set(color, (y * 4 + x) * 4);
  };
  put(1, 0, [10, 0, 0, 255]);
  put(0, 1, [0, 20, 0, 255]);
  put(1, 1, [0, 0, 30, 255]);
  put(2, 1, [40, 40, 0, 255]);
  put(3, 1, [50, 0, 50, 255]);
  put(1, 2, [0, 60, 60, 255]);
  return rgba;
}

describe("writeSkyboxCreatorFaceAssets", () => {
  it("creates six skybox Textures in the helper folder", async () => {
    const created: Array<{ relativePath: string; guid: string; name: string }> = [];
    const faces = await writeSkyboxCreatorFaceAssets({
      helperPath: "assets/skies/Day.skyboxcreator.babasset",
      payload: {
        sourceTextureGuid: "src-1",
        sourcePlacement: null,
        generatedFaces: emptySkyboxFaces(),
      },
      rgba: atlasRgba(),
      width: 4,
      height: 3,
      existingByGuid: new Map(),
      occupiedPaths: new Set(),
      rootId: "project",
      pathPrefix: "assets",
      encodePng: (width, height, rgba) => {
        expect(width).toBe(1);
        expect(height).toBe(1);
        expect(rgba.byteLength).toBe(4);
        return Uint8Array.of(width, height, rgba[0]!);
      },
      newGuid: (() => {
        let n = 0;
        return () => `face-${SKYBOX_FACE_KEYS[n++]!}`;
      })(),
      createAsset: async (_rootId, relativePath, result) => {
        created.push({
          relativePath,
          guid: result.guid,
          name: result.name,
        });
        expect(result.type).toBe("Texture");
        expect(result.payload).toEqual({ usage: "skybox" });
      },
      deleteAsset: async () => {
        throw new Error("should not delete on first create");
      },
    });
    expect(created.map((row) => row.relativePath)).toEqual([
      "skies/Day_px.babasset",
      "skies/Day_py.babasset",
      "skies/Day_pz.babasset",
      "skies/Day_nx.babasset",
      "skies/Day_ny.babasset",
      "skies/Day_nz.babasset",
    ]);
    expect(faces).toEqual({
      px: "face-px",
      py: "face-py",
      pz: "face-pz",
      nx: "face-nx",
      ny: "face-ny",
      nz: "face-nz",
    });
  });

  it("replaces previously generated face assets in place", async () => {
    const deleted: string[] = [];
    const created: string[] = [];
    await writeSkyboxCreatorFaceAssets({
      helperPath: "assets/Day.skyboxcreator.babasset",
      payload: {
        sourceTextureGuid: "src-1",
        sourcePlacement: null,
        generatedFaces: {
          px: "old-px",
          py: "old-py",
          pz: "old-pz",
          nx: "old-nx",
          ny: "old-ny",
          nz: "old-nz",
        },
      },
      rgba: atlasRgba(),
      width: 4,
      height: 3,
      existingByGuid: new Map(
        SKYBOX_FACE_KEYS.map((key) => [
          `old-${key}`,
          { path: `assets/Day_${key}.babasset` },
        ]),
      ),
      occupiedPaths: new Set(
        SKYBOX_FACE_KEYS.map((key) => `assets/Day_${key}.babasset`),
      ),
      rootId: "project",
      pathPrefix: "assets",
      encodePng: () => Uint8Array.of(1),
      newGuid: () => "unused",
      createAsset: async (_rootId, relativePath) => {
        created.push(relativePath);
      },
      deleteAsset: async (guid) => {
        deleted.push(guid);
      },
    });
    expect(deleted).toEqual([
      "old-px",
      "old-py",
      "old-pz",
      "old-nx",
      "old-ny",
      "old-nz",
    ]);
    expect(created).toEqual([
      "Day_px.babasset",
      "Day_py.babasset",
      "Day_pz.babasset",
      "Day_nx.babasset",
      "Day_ny.babasset",
      "Day_nz.babasset",
    ]);
  });

  it("writes square faces using sourcePlacement instead of contain-fit", async () => {
    const width = 8;
    const height = 2;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba.set([200, 10, 10, 255], i);
    }
    const encoded: Record<string, number[]> = {};
    await writeSkyboxCreatorFaceAssets({
      helperPath: "assets/Day.skyboxcreator.babasset",
      payload: {
        sourceTextureGuid: "src-1",
        sourcePlacement: { x: 0.25, y: 0, width: 0.25, height: 1 / 3 },
        generatedFaces: emptySkyboxFaces(),
      },
      rgba,
      width,
      height,
      existingByGuid: new Map(),
      occupiedPaths: new Set(),
      rootId: "project",
      pathPrefix: "assets",
      encodePng: (faceWidth, faceHeight, faceRgba) => {
        expect(faceWidth).toBe(faceHeight);
        return faceRgba.slice();
      },
      newGuid: (() => {
        let n = 0;
        return () => `face-${SKYBOX_FACE_KEYS[n++]!}`;
      })(),
      createAsset: async (_rootId, relativePath, result) => {
        const key = relativePath.replace("Day_", "").replace(".babasset", "");
        encoded[key] = [...(result.chunks[0]!.data as Uint8Array).slice(0, 4)];
      },
      deleteAsset: async () => {},
    });
    expect(encoded.py).toEqual([200, 10, 10, 255]);
    expect(encoded.pz).toEqual([0, 0, 0, 255]);
  });
});

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG_MAGIC = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
const KTX2_PREFIX = Uint8Array.of(
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
);
const STUB_KTX2 = new TextEncoder().encode("BABS-KTX2-STUB;format=uastc;");

describe("readTextureImageBytes", () => {
  it("prefers image pixels and reports the sniffed MIME", async () => {
    const png = await readTextureImageBytes(async (_path, chunkId) => {
      return chunkId === "pixels" ? PNG_MAGIC : JPEG_MAGIC;
    }, "assets/Sky.babasset");
    expect(png).toEqual({ bytes: PNG_MAGIC, mime: "image/png" });

    const jpeg = await readTextureImageBytes(async (_path, chunkId) => {
      return chunkId === "source" ? JPEG_MAGIC : new Uint8Array();
    }, "assets/Sky.babasset");
    expect(jpeg).toEqual({ bytes: JPEG_MAGIC, mime: "image/jpeg" });

    const missing = await readTextureImageBytes(async () => null, "assets/Sky.babasset");
    expect(missing).toBeNull();
  });

  it("skips KTX2 and stub-encode pixels and uses the source image", async () => {
    const fromKtx2 = await readTextureImageBytes(async (_path, chunkId) => {
      return chunkId === "pixels" ? KTX2_PREFIX : PNG_MAGIC;
    }, "assets/Sky.babasset");
    expect(fromKtx2).toEqual({ bytes: PNG_MAGIC, mime: "image/png" });

    const fromStub = await readTextureImageBytes(async (_path, chunkId) => {
      return chunkId === "pixels" ? STUB_KTX2 : JPEG_MAGIC;
    }, "assets/Sky.babasset");
    expect(fromStub).toEqual({ bytes: JPEG_MAGIC, mime: "image/jpeg" });
  });
});

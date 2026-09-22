import { describe, expect, it } from "vitest";
import { Constants, type BaseTexture } from "@babylonjs/core";
import type { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import {
  clusteredTextureAllocationBytes,
  clusteredTextureResources,
} from "./clustered-resource-cost";

function fakeTexture(
  format: number,
  type: number,
  width: number,
  height: number,
): BaseTexture {
  return {
    getInternalTexture: () => ({
      format,
      type,
      width,
      height,
      samples: 0,
      isCube: false,
      is3D: false,
      is2DArray: false,
      generateMipMaps: false,
    }),
  } as unknown as BaseTexture;
}

describe("clusteredTextureAllocationBytes", () => {
  it("keeps the pinned WebGL2 footprint", () => {
    expect(clusteredTextureAllocationBytes(23, 2, "webgl2")).toBe(
      2 * (64 * 64 * 4 + 5 * 23 * 16),
    );
  });

  it("adds the single R8 dummy RTT on WebGPU", () => {
    expect(clusteredTextureAllocationBytes(32, 2, "webgpu")).toBe(
      2 * (64 * 64 * 4 + 5 * 32 * 16) + 64 * 64,
    );
  });
});

describe("clusteredTextureResources WebGPU", () => {
  it("accounts the storage mask buffer alongside both textures", () => {
    const buffer = { capacity: 64 * 64 * 4 * 2 };
    const container = {
      _lightDataTexture: fakeTexture(
        Constants.TEXTUREFORMAT_RGBA,
        Constants.TEXTURETYPE_FLOAT,
        64,
        5 * 32,
      ),
      _tileMaskTexture: fakeTexture(
        Constants.TEXTUREFORMAT_R,
        Constants.TEXTURETYPE_UNSIGNED_BYTE,
        64,
        64,
      ),
      _tileMaskBuffer: { getBuffer: () => buffer },
      horizontalTiles: 64,
      verticalTiles: 64,
    } as unknown as ClusteredLightContainer;
    const resources = clusteredTextureResources(container);
    expect(resources).toHaveLength(3);
    expect(resources[2]).toEqual({
      handle: buffer,
      bytes: 64 * 64 * 4 * 2,
    });
    expect(resources[1]!.bytes).toBe(64 * 64);
  });
});

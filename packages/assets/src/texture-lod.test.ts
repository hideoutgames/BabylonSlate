import { describe, expect, it } from "vitest";
import {
  authoredTextureMaxDimension,
  migrateMaxDimensionToDownsample,
  resolveTextureTargetEdge,
  textureDownsampleFromPayload,
  TEXTURE_LOD_FLOOR,
} from "./texture-lod";

describe("resolveTextureTargetEdge", () => {
  it("leaves 256 maps unchanged when engine LOD is on at 50%", () => {
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 256,
        downsample: 1,
        lodEnabled: true,
        lodQuality: 0.5,
        usage: "albedo",
      }),
    ).toBe(256);
  });

  it("halves 4K albedo when engine LOD is on at 50%", () => {
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 4096,
        downsample: 1,
        lodEnabled: true,
        lodQuality: 0.5,
        usage: "albedo",
      }),
    ).toBe(2048);
  });

  it("does not upscale maps smaller than the floor", () => {
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 128,
        downsample: 1,
        lodEnabled: true,
        lodQuality: 0.5,
        usage: "albedo",
      }),
    ).toBe(128);
  });

  it("ignores engine LOD when the toggle is off", () => {
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 4096,
        downsample: 1,
        lodEnabled: false,
        lodQuality: 0.5,
        usage: "albedo",
      }),
    ).toBe(4096);
  });

  it("applies per-texture 1/4 with engine off", () => {
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 4096,
        downsample: 4,
        lodEnabled: false,
        lodQuality: 0.5,
        usage: "albedo",
      }),
    ).toBe(1024);
  });

  it("uses the stricter of engine LOD and per-texture downsample", () => {
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 4096,
        downsample: 4,
        lodEnabled: true,
        lodQuality: 0.5,
        usage: "albedo",
      }),
    ).toBe(1024);
  });

  it("does not apply engine LOD to skybox or pixelArt", () => {
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 4096,
        downsample: 1,
        lodEnabled: true,
        lodQuality: 0.25,
        usage: "skybox",
      }),
    ).toBe(4096);
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 4096,
        downsample: 1,
        lodEnabled: true,
        lodQuality: 0.25,
        usage: "pixelArt",
      }),
    ).toBe(4096);
  });

  it("still applies per-texture downsample to LOD-exempt usages", () => {
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 2048,
        downsample: 2,
        lodEnabled: true,
        lodQuality: 0.25,
        usage: "pixelArt",
      }),
    ).toBe(1024);
  });

  it("never goes below the floor when the source is larger than the floor", () => {
    expect(TEXTURE_LOD_FLOOR).toBe(256);
    expect(
      resolveTextureTargetEdge({
        sourceEdge: 512,
        downsample: 16,
        lodEnabled: true,
        lodQuality: 0.25,
        usage: "albedo",
      }),
    ).toBe(256);
  });
});

describe("textureDownsampleFromPayload", () => {
  it("defaults Full when downsample is missing", () => {
    expect(textureDownsampleFromPayload({})).toBe(1);
  });

  it("reads downsample 1/2/4/8/16", () => {
    expect(textureDownsampleFromPayload({ downsample: 4 })).toBe(4);
    expect(textureDownsampleFromPayload({ downsample: 16 })).toBe(16);
  });

  it("migrates a legacy maxDimension against source size", () => {
    expect(migrateMaxDimensionToDownsample(1024, 4096)).toBe(4);
    expect(migrateMaxDimensionToDownsample(2048, 2048)).toBe(1);
    expect(migrateMaxDimensionToDownsample(undefined, 4096)).toBe(1);
  });

  it("uses migrated maxDimension when downsample is absent", () => {
    expect(
      textureDownsampleFromPayload({ maxDimension: 1024 }, 4096),
    ).toBe(4);
  });
});

describe("authoredTextureMaxDimension", () => {
  it("is source over downsample, ignoring engine LOD", () => {
    expect(
      authoredTextureMaxDimension({
        sourceEdge: 4096,
        downsample: 2,
      }),
    ).toBe(2048);
  });
});

import { describe, expect, it } from "vitest";
import { A16_ENCODE_FIXTURES, A16_POLICY } from "@babylonslate/test-kit";
import { read as readKtx2 } from "ktx-parse";
import {
  createNodeBasisEncodeFn,
  readVendoredBasisPresent,
  syntheticRgbaForSize,
} from "./node-basis-encode";
import { DEFAULT_TEXTURE_ENCODE_SETTINGS } from "./texture-compression";

describe("A16 encode CI smoke (real Basis wasm)", () => {
  it("vendored basis encoder is present", () => {
    expect(readVendoredBasisPresent()).toBe(true);
  });

  it("encodes 512 UASTC KTX2 under the fixture wall envelope", async () => {
    const fixture = A16_ENCODE_FIXTURES.find(
      (entry) => entry.size === 512 && entry.format === "png",
    )!;
    const encode = createNodeBasisEncodeFn((_source, settings) => {
      const size = Math.min(512, settings.maxDimension);
      return syntheticRgbaForSize(size);
    });

    const { ktx2, wallMs } = await encode(new Uint8Array([0]), {
      ...DEFAULT_TEXTURE_ENCODE_SETTINGS,
      maxDimension: A16_POLICY.defaultMaxDimension,
      generateMipmaps: false,
    });

    expect(wallMs).toBeLessThanOrEqual(fixture.a16WallMsMax);
    expect(ktx2.byteLength).toBeGreaterThan(32);
    const container = readKtx2(ktx2);
    expect(container.pixelWidth).toBe(512);
    expect(container.pixelHeight).toBe(512);
    expect(container.levels.length).toBeGreaterThan(0);
  }, 60_000);
});

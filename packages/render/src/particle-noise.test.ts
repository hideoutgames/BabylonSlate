import { describe, expect, it } from "vitest";
import { createParticleBuiltinNoise, particleNoisePixelsFrom } from "./particle-noise";

describe("particle noise pixels", () => {
  it("generates the same tileable built-in noise every time, spread over the red, green and blue range", () => {
    const first = createParticleBuiltinNoise(64);
    expect(first).toEqual(createParticleBuiltinNoise(64));
    expect(first.data.length).toBe(64 * 64 * 4);
    for (let channel = 0; channel < 3; channel += 1) {
      const values = Array.from({ length: 64 * 64 }, (_, index) => first.data[index * 4 + channel]!);
      expect(Math.min(...values)).toBeLessThan(96);
      expect(Math.max(...values)).toBeGreaterThan(160);
    }
    expect(Array.from({ length: 64 * 64 }, (_, index) => first.data[index * 4 + 3]).every((alpha) => alpha === 255)).toBe(true);
    // Another seed is another field.
    expect(createParticleBuiltinNoise(64, 7).data).not.toEqual(first.data);
  });

  it("reads 8-bit and float read-backs as RGBA8 and refuses a short buffer", () => {
    const size = { width: 1, height: 2 };
    expect(particleNoisePixelsFrom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), size)?.data).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(particleNoisePixelsFrom(new Float32Array([0, 0.5, 1, 2, -1, 0, 0, 1]), size)?.data).toEqual(new Uint8Array([0, 128, 255, 255, 0, 0, 0, 255]));
    expect(particleNoisePixelsFrom(new Uint8Array(4), size)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { WaterSurfaceSampler } from "./water-surface-sampler";

describe("Rendered water surface sampling", () => {
  it("interpolates the displaced triangles and follows live wave heights without rebuilding", () => {
    const base = new Float32Array([0, 2, 0, 4, 2, 0, 0, 2, 4, 4, 2, 4]);
    const waves = new Float32Array([0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const sampler = new WaterSurfaceSampler(base, waves, [0, 1, 2, 1, 3, 2]);
    // The actual triangle is planar: the midpoint and shared diagonal use the vertex heights.
    expect(sampler.heightAt(1, 1)).toBeCloseTo(3);
    expect(sampler.heightAt(2, 2)).toBeCloseTo(4);
    expect(sampler.heightAt(4, 0)).toBeCloseTo(6);
    expect(sampler.heightAt(3, 3)).toBeCloseTo(3);
    expect(sampler.heightAt(-0.1, 1)).toBeNull();
    waves[4] = 8;
    expect(sampler.heightAt(1, 1)).toBeCloseTo(4);
    expect(sampler.heightAt(3, 3)).toBeCloseTo(4);
  });

  it("finds the highest overlapping river sheet across spatial partitions and rejects holes", () => {
    const positions: number[] = [], indices: number[] = [];
    // Separated strips force spatial partitions; two overlapping strips differ in elevation.
    for (let i = 0; i < 10; i++) {
      const x = i < 2 ? 0 : i * 10, y = i === 1 ? 3 : 1;
      positions.push(x, y, 0, x + 4, y, 0, x, y, 4);
      indices.push(i * 3, i * 3 + 1, i * 3 + 2);
    }
    const sampler = new WaterSurfaceSampler(new Float32Array(positions), new Float32Array(positions.length / 3 * 4), indices);
    expect(sampler.heightAt(1, 1)).toBeCloseTo(3);
    expect(sampler.heightAt(91, 1)).toBeCloseTo(1);
    expect(sampler.heightAt(3, 3)).toBeNull();
    expect(sampler.heightAt(15, 1)).toBeNull();
  });
});

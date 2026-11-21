import { describe, expect, it } from "vitest";
import {
  decodeLandscapeChunk,
  encodeLandscapeChunk,
  isFlatDefaultLandscape,
  landscapeHeightField,
  LandscapeSculptSession,
  normalizeSerializedLandscapeProperties,
  parseLandscapeProperties,
  quantizeVertexWeights,
  resizeLandscape,
  sculptLandscape,
  serializeLandscapeProperties,
  type LandscapeBrush,
} from "./landscape";
import { createActor, normalizeScene } from "./scene";
import { createDefaultScene } from "./project";

const brush: LandscapeBrush = { tool: "raise", radius: 1.5, strength: 2, falloff: 1, height: 4, layer: 2 };

describe("landscape binary BSLD codec & authoring", () => {
  it("encodes and decodes BSLD binary chunks losslessly and rejects malformed bytes", () => {
    const data = parseLandscapeProperties({ width: 16, depth: 16, subdivisions: 8, collisionsEnabled: true });
    data.heights[0] = -3.25;
    data.heights[40] = 12.5;
    quantizeVertexWeights(0.5, 0.25, 0.15, 0.1, data.weights, 40 * 4);
    expect(isFlatDefaultLandscape(data)).toBe(false);

    const bytes = encodeLandscapeChunk(data);
    expect(bytes.byteLength).toBe(16 + 81 * 8);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe("BSLD");

    const decoded = decodeLandscapeChunk(bytes);
    expect(decoded.subdivisions).toBe(8);
    expect(decoded.heights[0]).toBeCloseTo(-3.25, 5);
    expect(decoded.heights[40]).toBeCloseTo(12.5, 5);
    expect(decoded.weights.slice(40 * 4, 40 * 4 + 4)).toEqual(data.weights.slice(40 * 4, 40 * 4 + 4));
    expect(
      decoded.weights[40 * 4]! +
      decoded.weights[40 * 4 + 1]! +
      decoded.weights[40 * 4 + 2]! +
      decoded.weights[40 * 4 + 3]!,
    ).toBe(255);

    const parsedFromBytes = parseLandscapeProperties(
      { width: 16, depth: 16, subdivisions: 8, collisionsEnabled: true },
      bytes,
    );
    expect(parsedFromBytes.heights).toEqual(decoded.heights);
    expect(parsedFromBytes.weights).toEqual(decoded.weights);

    // Reject truncated, bad-magic, bad-format, and mismatched-length chunks.
    expect(() => decodeLandscapeChunk(new Uint8Array(8))).toThrow("truncated");
    const badMagic = bytes.slice(); badMagic[0] = 0x58;
    expect(() => decodeLandscapeChunk(badMagic)).toThrow("bad magic");
    const badFormat = bytes.slice(); new DataView(badFormat.buffer).setUint32(4, 99, true);
    expect(() => decodeLandscapeChunk(badFormat)).toThrow("format");
    expect(() => decodeLandscapeChunk(bytes.slice(0, bytes.byteLength - 4))).toThrow("byte length");
  });

  it("omits binary data for flat default terrains and preserves sculpted fields across Scene JSON normalization", () => {
    const flat = parseLandscapeProperties({ width: 64, depth: 64, subdivisions: 64 });
    expect(isFlatDefaultLandscape(flat)).toBe(true);
    expect(serializeLandscapeProperties(flat).data).toBeNull();

    const data = parseLandscapeProperties({ width: 4, depth: 4, subdivisions: 4, collisionsEnabled: true });
    const painted = sculptLandscape(data, 0, 0, { ...brush, tool: "paint", strength: 0.25 });
    expect(Array.from(painted.weights.slice(48, 52))).toEqual([191, 0, 64, 0]);
    const serialized = serializeLandscapeProperties(painted);
    expect(typeof serialized.data).toBe("string");

    const scene = normalizeScene(JSON.parse(JSON.stringify({
      ...createDefaultScene(),
      actors: [createActor("terrain", "Terrain", {
        components: [{ id: "heightfield", classId: "LandscapeComponent", properties: { ...serialized } }],
      })],
    })));
    const roundTripped = parseLandscapeProperties(scene.actors[0]!.components[0]!.properties);
    expect(roundTripped.weights).toEqual(painted.weights);
    expect(roundTripped.collisionsEnabled).toBe(true);
    expect(normalizeSerializedLandscapeProperties(painted)).toEqual(serialized);

    const resized = resizeLandscape(painted, 8);
    expect(Array.from(resized.weights.slice(160, 164))).toEqual([191, 0, 64, 0]);
    expect(resized.collisionsEnabled).toBe(true);
  });

  it("sculpts within the footprint without mutating the undo snapshot", () => {
    const before = parseLandscapeProperties({ width: 4, depth: 4, subdivisions: 4 });
    const after = sculptLandscape(before, 0, 0, brush);
    expect(after.heights[12]).toBe(2);
    expect(after.heights[0]).toBe(0);
    expect(after.heights[11]).toBeGreaterThan(0);
    expect(after.heights[11]).toBeLessThan(2);
    expect(before.heights.every((height) => height === 0)).toBe(true);
    expect(sculptLandscape(after, 0, 0, { ...brush, tool: "lower" }).heights[12]).toBe(0);
  });

  it("smooths from the previous heightfield and flattens toward the specified height", () => {
    const data = parseLandscapeProperties({ width: 4, depth: 4, subdivisions: 4 });
    data.heights[12] = 9;
    const smooth = sculptLandscape(data, 0, 0, { ...brush, tool: "smooth", strength: 1 });
    expect(smooth.heights[12]).toBe(1);
    expect(smooth.heights[11]).toBeGreaterThan(0);
    const flat = sculptLandscape(data, 0, 0, { ...brush, tool: "flatten", strength: 0.5 });
    expect(flat.heights[12]).toBe(6.5);
  });

  it("resamples a planar heightfield, exposes heightfield collider descriptor, and rejects nonfinite brush coordinates", () => {
    const heights = new Float32Array(25);
    for (let i = 0; i < 25; i++) heights[i] = i % 5;
    const data = parseLandscapeProperties({ width: 4, depth: 4, subdivisions: 4, heights, collisionsEnabled: true });
    const hf = landscapeHeightField(data)!;
    expect(hf).toEqual({ kind: "heightfield", numXSamples: 5, numZSamples: 5, width: 4, depth: 4, heights: data.heights });
    expect(landscapeHeightField({ ...data, collisionsEnabled: false })).toBeNull();
    const resized = resizeLandscape(data, 8);
    expect(resized.heights[1]).toBe(0.5);
    expect(resized.heights[80]).toBe(4);
    expect(sculptLandscape(data, NaN, 0, brush)).toBe(data);
    expect(parseLandscapeProperties({ subdivisions: Infinity }).heights[0]).toBe(0);
  });
});

describe("landscape sculpt session", () => {
  const initial = (() => {
    const data = parseLandscapeProperties({ width: 20, depth: 12, subdivisions: 24, materialGuid: "ground", collisionsEnabled: true });
    for (let i = 0; i < data.heights.length; i++) data.heights[i] = Math.sin(i) * 3;
    return serializeLandscapeProperties(data);
  })();
  const tools: LandscapeBrush["tool"][] = ["paint", "paint", "raise", "lower", "smooth", "flatten", "paint"];
  function dabs(count: number) {
    let seed = 7;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)) / 0x100000000;
    return Array.from({ length: count }, (_, n) => ({
      x: n === 40 ? NaN : random() * 24 - 12,
      z: random() * 16 - 8,
      brush: {
        tool: tools[n % tools.length]!,
        radius: 0.5 + random() * 4.5,
        strength: n % 23 === 0 ? 0 : random() * 2,
        falloff: 0.05 + random() * 0.95,
        height: random() * 10 - 5,
        layer: Math.floor(random() * 4),
      } satisfies LandscapeBrush,
    }));
  }

  it("equals repeated immutable sculptLandscape calls bit for bit over a long mixed stroke", () => {
    const session = new LandscapeSculptSession(initial);
    let expected = parseLandscapeProperties(initial);
    for (const dab of dabs(200)) {
      expected = sculptLandscape(expected, dab.x, dab.z, dab.brush);
      session.dab(dab.x, dab.z, dab.brush);
    }
    const result = session.snapshot();
    expect(result.heights).toEqual(expected.heights);
    expect(result.weights).toEqual(expected.weights);
    expect(result.weights.some((weight) => weight > 0 && weight < 255)).toBe(true);
    expect(result.heights.some((height) => height !== 0)).toBe(true);
    expect(parseLandscapeProperties(session.toSerializedProperties())).toEqual(result);
  });

  it("leaves the source document and earlier snapshots untouched by later dabs", () => {
    const source = structuredClone(initial);
    const frozen = structuredClone(initial);
    const session = new LandscapeSculptSession(source);
    session.dab(0, 0, brush);
    const first = session.snapshot();
    const firstHeights = first.heights.slice();
    const firstWeights = first.weights.slice();
    session.dab(2, 1, { ...brush, tool: "paint", strength: 0.5 });
    session.dab(-3, 2, { ...brush, tool: "lower" });
    expect(source).toEqual(frozen);
    expect(first.heights).toEqual(firstHeights);
    expect(first.weights).toEqual(firstWeights);
    expect(session.snapshot().heights).not.toEqual(firstHeights);
  });
});

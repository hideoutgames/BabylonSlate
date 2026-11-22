import { describe, expect, it } from "vitest";
import {
  decodeLandscapeBase64ToBytes,
  decodeLandscapeChunk,
  decodeLandscapeField,
  encodeLandscapeBase64,
  encodeLandscapeChunk,
  isFlatDefaultLandscape,
  landscapeHeightField,
  LandscapeSculptSession,
  normalizeSerializedLandscapeProperties,
  parseLandscapeProperties,
  quantizeVertexWeights,
  resizeLandscape,
  serializeLandscapeProperties,
  type LandscapeBrush,
  type LandscapeProperties,
} from "./landscape";
import { createActor, normalizeScene } from "./scene";
import { createDefaultScene } from "./project";

const brush: LandscapeBrush = { tool: "raise", radius: 1.5, strength: 2, falloff: 1, height: 4, layer: 2 };

/** The terrain after one dab, from a fresh session over `terrain` (which the session never mutates). */
function sculpted(terrain: LandscapeProperties, x: number, z: number, dab: LandscapeBrush): LandscapeProperties {
  const session = new LandscapeSculptSession(terrain);
  session.dab(x, z, dab);
  return session.liveProperties();
}

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

    const decoded = decodeLandscapeChunk(bytes)!;
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

    // Truncated, bad-magic, bad-format and mismatched-length chunks decode to null instead of throwing.
    const badMagic = bytes.slice(); badMagic[0] = 0x58;
    const badFormat = bytes.slice(); new DataView(badFormat.buffer).setUint32(4, 99, true);
    for (const corrupt of [new Uint8Array(8), badMagic, badFormat, bytes.slice(0, bytes.byteLength - 4)]) {
      expect(decodeLandscapeChunk(corrupt)).toBeNull();
    }
  });

  it("reports unreadable field data as null and parses it as flat terrain without throwing", () => {
    const meta = { width: 16, depth: 16, subdivisions: 8, materialGuid: "ground", collisionsEnabled: true };
    const raised = parseLandscapeProperties(meta);
    raised.heights[40] = 4;
    const bytes = encodeLandscapeChunk(raised);
    const coarse = parseLandscapeProperties({ ...meta, subdivisions: 4 });
    const unreadable: Array<[unknown, Uint8Array | undefined]> = [
      [{ ...meta, chunkId: "landscape:terrain" }, bytes.slice(0, 20)],
      [{ ...meta, chunkId: "landscape:terrain" }, encodeLandscapeChunk(coarse)],
      // A chunk id whose bytes were not supplied (a missing chunk).
      [{ ...meta, chunkId: "landscape:terrain" }, undefined],
      // Not base64 at all: `atob` would throw.
      [{ ...meta, data: "%%%not base64%%%" }, undefined],
      [{ ...meta, data: encodeLandscapeBase64(coarse) }, undefined],
    ];
    for (const [value, chunk] of unreadable) {
      expect(decodeLandscapeField(value, chunk)).toBeNull();
      const flat = parseLandscapeProperties(value, chunk);
      expect(flat.heights.length).toBe(81);
      expect(flat.heights.every((height) => height === 0)).toBe(true);
      expect(flat.materialGuid).toBe("ground");
      expect(flat.collisionsEnabled).toBe(true);
    }
    expect(decodeLandscapeBase64ToBytes("%%%not base64%%%")).toBeNull();
    expect(decodeLandscapeField({ ...meta, chunkId: "landscape:terrain" }, bytes)!.heights[40]).toBe(4);
    // No field data at all is the flat default, not unreadable data.
    expect(decodeLandscapeField(meta)!.heights.every((height) => height === 0)).toBe(true);
  });

  it("omits binary data for flat default terrains and preserves sculpted fields across Scene JSON normalization", () => {
    const flat = parseLandscapeProperties({ width: 64, depth: 64, subdivisions: 64 });
    expect(isFlatDefaultLandscape(flat)).toBe(true);
    expect(serializeLandscapeProperties(flat).data).toBeNull();

    const data = parseLandscapeProperties({ width: 4, depth: 4, subdivisions: 4, collisionsEnabled: true });
    const painted = sculpted(data, 0, 0,{ ...brush, tool: "paint", strength: 0.25 });
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
    const after = sculpted(before, 0, 0, brush);
    expect(after.heights[12]).toBe(2);
    expect(after.heights[0]).toBe(0);
    expect(after.heights[11]).toBeGreaterThan(0);
    expect(after.heights[11]).toBeLessThan(2);
    expect(before.heights.every((height) => height === 0)).toBe(true);
    expect(sculpted(after, 0, 0, { ...brush, tool: "lower" }).heights[12]).toBe(0);
  });

  it("smooths from the previous heightfield and flattens toward the specified height", () => {
    const data = parseLandscapeProperties({ width: 4, depth: 4, subdivisions: 4 });
    data.heights[12] = 9;
    const smooth = sculpted(data, 0, 0, { ...brush, tool: "smooth", strength: 1 });
    expect(smooth.heights[12]).toBe(1);
    expect(smooth.heights[11]).toBeGreaterThan(0);
    const flat = sculpted(data, 0, 0,{ ...brush, tool: "flatten", strength: 0.5 });
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
    const ignored = new LandscapeSculptSession(data);
    ignored.dab(NaN, 0, brush);
    ignored.dab(0, 0, { ...brush, strength: 0 });
    expect(ignored.hasChanges).toBe(false);
    expect(ignored.takeDirtyRegion()).toBeNull();
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

  it("keeps a long mixed stroke's weights summing to 255 and its serialized form equal to the live terrain", () => {
    const session = new LandscapeSculptSession(initial);
    for (const dab of dabs(200)) session.dab(dab.x, dab.z, dab.brush);
    const result = session.liveProperties();
    for (let at = 0; at < result.weights.length; at += 4) {
      expect(result.weights[at]! + result.weights[at + 1]! + result.weights[at + 2]! + result.weights[at + 3]!).toBe(255);
    }
    expect(result.weights.some((weight) => weight > 0 && weight < 255)).toBe(true);
    expect(result.heights.some((height) => height !== 0)).toBe(true);
    expect(parseLandscapeProperties(session.toSerializedProperties())).toEqual(result);
  });

  it.each([
    // The layer's weight after n dabs of blend b at the brush centre is 1 - (1 - b)^n. Rounding to bytes on every
    // dab stalled these at 5, 245 and 253.
    { strength: 0.002, expected: Math.round(255 * (1 - 0.998 ** 400)) },
    { strength: 0.05, expected: 255 },
    { strength: 0.2, expected: 255 },
  ])("accumulates 400 paint dabs of strength $strength as unrounded maths does", ({ strength, expected }) => {
    const session = new LandscapeSculptSession({ width: 8, depth: 8, subdivisions: 8 });
    for (let n = 0; n < 400; n++) session.dab(0, 0, { tool: "paint", radius: 2, strength, falloff: 1, height: 0, layer: 1 });
    const centre = (4 * 9 + 4) * 4;
    const weights = session.liveProperties().weights;
    expect(Math.abs(weights[centre + 1]! - expected)).toBeLessThanOrEqual(1);
    expect(weights[centre]! + weights[centre + 1]! + weights[centre + 2]! + weights[centre + 3]!).toBe(255);
    const committed = parseLandscapeProperties(session.toSerializedProperties()).weights;
    expect(committed.slice(centre, centre + 4)).toEqual(weights.slice(centre, centre + 4));
  });

  it("reports the samples each preview must re-upload, once", () => {
    const session = new LandscapeSculptSession({ width: 32, depth: 32, subdivisions: 32 });
    session.dab(-10, -10, { ...brush, radius: 2 });
    session.dab(-8, -10, { ...brush, tool: "paint", radius: 2 });
    // Local (-10, -10) is sample 6: a radius of 2 reaches samples 4..8, and the second dab 6..10 in X.
    expect(session.takeDirtyRegion()).toEqual({ x0: 4, z0: 4, x1: 10, z1: 8 });
    expect(session.takeDirtyRegion()).toBeNull();
    session.dab(15, 15, { ...brush, radius: 3 });
    expect(session.takeDirtyRegion()).toEqual({ x0: 28, z0: 28, x1: 32, z1: 32 });
  });

  it("leaves the source document untouched by its dabs", () => {
    const source = structuredClone(initial);
    const frozen = structuredClone(initial);
    const session = new LandscapeSculptSession(source);
    session.dab(0, 0, brush);
    session.dab(2, 1, { ...brush, tool: "paint", strength: 0.5 });
    session.dab(-3, 2, { ...brush, tool: "lower" });
    expect(source).toEqual(frozen);
    expect(session.liveProperties().heights).not.toEqual(parseLandscapeProperties(frozen).heights);
  });
});

import { describe, expect, it } from "vitest";
import { LandscapeSculptSession, parseLandscapeProperties, resizeLandscape, sculptLandscape, type LandscapeBrush } from "./landscape";
import { createActor, normalizeScene } from "./scene";
import { createDefaultScene } from "./project";

const brush: LandscapeBrush = { tool: "raise", radius: 1.5, strength: 2, falloff: 1, height: 4, layer: 2 };
describe("landscape authoring", () => {
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
  it("normalizes paint weights and persists them together with heights", () => {
    const data = parseLandscapeProperties({ width: 4, depth: 4, subdivisions: 4, collisionsEnabled: true });
    const painted = sculptLandscape(data, 0, 0, { ...brush, tool: "paint", strength: 0.25 });
    expect(painted.weights.slice(48, 52)).toEqual([0.75, 0, 0.25, 0]);
    const scene = normalizeScene(JSON.parse(JSON.stringify({ ...createDefaultScene(), actors: [createActor("terrain", "Terrain", { components: [{ id: "heightfield", classId: "LandscapeComponent", properties: { ...painted } }] })] })));
    expect(scene.actors[0]!.components[0]!.properties.weights).toEqual(painted.weights);
    expect(scene.actors[0]!.components[0]!.properties.collisionsEnabled).toBe(true);
    const resized = resizeLandscape(painted, 8);
    expect(resized.weights.slice(160, 164)).toEqual([0.75, 0, 0.25, 0]);
    expect(resized.collisionsEnabled).toBe(true);
  });
  it("resamples a planar heightfield and rejects nonfinite brush coordinates", () => {
    const data = parseLandscapeProperties({ width: 4, depth: 4, subdivisions: 4, heights: Array.from({ length: 25 }, (_, i) => i % 5) });
    const resized = resizeLandscape(data, 8);
    expect(resized.heights[1]).toBe(0.5);
    expect(resized.heights[80]).toBe(4);
    expect(sculptLandscape(data, NaN, 0, brush)).toBe(data);
    expect(parseLandscapeProperties({ subdivisions: Infinity, heights: [NaN] }).heights[0]).toBe(0);
  });
});

describe("landscape sculpt session", () => {
  // A stored document the way older scenes and hand edits leave it: short, out-of-range and non-finite
  // heights, weights that are partial, unnormalized or invalid.
  const stored = {
    width: 20, depth: 12, subdivisions: 24, materialGuid: "ground", collisionsEnabled: true, unrelated: "dropped by the first dab",
    heights: Array.from({ length: 600 }, (_, i) => i % 97 === 0 ? 50000 : i % 53 === 0 ? NaN : Math.sin(i) * 3),
    weights: Array.from({ length: 2000 }, (_, i) => i % 29 === 0 ? NaN : i % 7 === 0 ? 2 : i % 11 === 0 ? -1 : (i * 0.37) % 1),
  };
  const tools: LandscapeBrush["tool"][] = ["paint", "paint", "raise", "lower", "smooth", "flatten", "paint"];
  function dabs(count: number) {
    let seed = 7;
    const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000;
    return Array.from({ length: count }, (_, n) => ({
      // Past the terrain's edge on purpose, and a rejected dab (zero strength / NaN) now and then.
      x: n === 40 ? NaN : random() * 24 - 12, z: random() * 16 - 8,
      brush: { tool: tools[n % tools.length]!, radius: 0.5 + random() * 4.5, strength: n % 23 === 0 ? 0 : random() * 2, falloff: 0.05 + random() * 0.95, height: random() * 10 - 5, layer: Math.floor(random() * 4) } satisfies LandscapeBrush,
    }));
  }

  it("equals re-parsing the document before every dab, bit for bit, over a long mixed stroke", () => {
    const session = new LandscapeSculptSession(stored);
    let document: unknown = stored;
    for (const dab of dabs(400)) {
      document = { ...sculptLandscape(parseLandscapeProperties(document), dab.x, dab.z, dab.brush) };
      session.dab(dab.x, dab.z, dab.brush);
      expect(session.snapshot()).toEqual(document);
    }
    // The stroke really painted and sculpted, so the comparison is not trivially a flat default.
    const result = session.snapshot();
    expect(result.weights.some((weight) => weight > 0 && weight < 1)).toBe(true);
    expect(result.heights.some((height) => height !== 0)).toBe(true);
  });

  it("leaves the source document and earlier snapshots untouched by later dabs", () => {
    const source = structuredClone(stored);
    const frozen = structuredClone(stored);
    const session = new LandscapeSculptSession(source);
    session.dab(0, 0, brush);
    const first = session.snapshot();
    const firstCopy = structuredClone(first);
    session.dab(2, 1, { ...brush, tool: "paint", strength: 0.5 });
    session.dab(-3, 2, { ...brush, tool: "lower" });
    expect(source).toEqual(frozen);
    expect(first).toEqual(firstCopy);
    expect(session.snapshot()).not.toEqual(first);
  });
});

import { describe, expect, it } from "vitest";
import { parseLandscapeProperties, resizeLandscape, sculptLandscape, type LandscapeBrush } from "./landscape";
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

import { expect, it } from "vitest";
import { HAPTIC_LIGHTING_FUNCTIONS_GLSL, HAPTIC_LIGHTING_FUNCTIONS_WGSL } from "./haptic-lighting-shader";

/** The body of the function whose header starts with `header`, up to the closing brace of its own line. */
function body(source: string, header: string): string {
  const from = source.indexOf(header);
  expect(from, header).toBeGreaterThanOrEqual(0);
  const to = source.indexOf("\n}", from);
  return source.slice(from, to);
}

const calls = (text: string, name: string) => text.split(`${name}(`).length - 1;

// The source text is the contract here: Direct3D's shader compiler inlines every call, and each inlined copy of the
// shadow filter adds over a second to a lit program's link, so a lit surface's light function looks shadows up from
// one call site (its one loop over the sun's cascades and the cluster's point and spot lights).
it.each([
  ["GLSL PBR", HAPTIC_LIGHTING_FUNCTIONS_GLSL, "void hapticDirectLights("],
  ["GLSL CEL", HAPTIC_LIGHTING_FUNCTIONS_GLSL, "vec3 hapticCelLighting("],
  ["WGSL PBR", HAPTIC_LIGHTING_FUNCTIONS_WGSL, "fn hapticDirectLights("],
  ["WGSL CEL", HAPTIC_LIGHTING_FUNCTIONS_WGSL, "fn hapticCelLighting("],
])("a lit surface's light function looks shadows up from one call site: %s", (_name, source, header) => {
  const lights = body(source, header);
  expect(calls(lights, "hapticShadow")).toBe(1);
  // The helpers that each hold a lookup of their own are for other shaders (volumetric lighting).
  expect(calls(lights, "hapticSunShadowFactor") + calls(lights, "hapticPointShadow")).toBe(0);
  // Every light kind is still summed: the sun's lights, then the cluster's points and spots, then the rect lights.
  for (const part of ["hapticDirectional[", "hapticPoint[", "hapticSpot[", "hapticRect["]) expect(lights, part).toContain(part);
});

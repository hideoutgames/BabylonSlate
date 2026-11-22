import { expect, it } from "vitest";
import { celFunctions } from "./cel-shader";
import { HAPTIC_LIGHTING_FUNCTIONS_GLSL } from "./haptic-lighting-shader";

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
])("a lit surface's light function looks shadows up from one call site: %s", (_name, source, header) => {
  const lights = body(source, header);
  expect(calls(lights, "hapticShadow")).toBe(1);
  // The helpers that each hold a lookup of their own are for other shaders (volumetric lighting).
  expect(calls(lights, "hapticSunShadowFactor") + calls(lights, "hapticPointShadow")).toBe(0);
  // Every light kind is still summed: the sun's lights, then the cluster's points and spots, then the rect lights.
  for (const part of ["hapticDirectional[", "hapticPoint[", "hapticSpot[", "hapticRect["]) expect(lights, part).toContain(part);
});

// GLSL ES 3.00 leaves derivatives undefined in non-uniform control flow, and the light loops branch per fragment
// (`break`, `continue`): only the light functions' first lines, before their loops, take the position's derivatives, and
// CEL's anti-aliased thresholds (its only other derivatives) run after its loops on the summed light.
it("takes derivatives only where control flow is uniform", () => {
  const derivatives = /\b(dFdx|dFdy|fwidth)\(/g;
  const prologue = "vec3 dPdx = dFdx(P);\n  vec3 dPdy = dFdy(P);";
  expect(HAPTIC_LIGHTING_FUNCTIONS_GLSL.split(prologue).length - 1).toBe(2);
  expect(HAPTIC_LIGHTING_FUNCTIONS_GLSL.split(prologue).join("").match(derivatives)).toBeNull();
  for (const header of ["void hapticDirectLights(", "vec3 hapticCelLighting("]) {
    const lights = body(HAPTIC_LIGHTING_FUNCTIONS_GLSL, header);
    expect(lights.indexOf(prologue), header).toBeLessThan(lights.indexOf("for ("));
  }
  const cel = celFunctions();
  const thresholds = ["float hapticCelStep(", "float hapticCelEdge("].map((header) => body(cel, header));
  expect(thresholds.reduce((rest, threshold) => rest.replace(threshold, ""), cel).match(derivatives)).toBeNull();
  const lights = body(HAPTIC_LIGHTING_FUNCTIONS_GLSL, "vec3 hapticCelLighting(");
  const loops = lights.slice(lights.indexOf("for ("), lights.indexOf("// After the loop"));
  expect(loops.length).toBeGreaterThan(0);
  for (const threshold of ["hapticCelStep", "hapticCelEdge", "hapticCelBand"]) expect(calls(loops, threshold), threshold).toBe(0);
});

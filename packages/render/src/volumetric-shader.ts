import { VOLUME_SHADOW_CODE } from "./volumetric-lights";
import { MAX_FOG_VOLUMES } from "./fog-volumes";
import { HAPTIC_SHADOW_ATLAS, hapticShadowGlsl, hapticShadowWgsl } from "./haptic-lighting-shader";
import { HAPTIC_LIGHTS_GLSL, HAPTIC_LIGHTS_WGSL } from "./haptic-lights";
import { syntax } from "./ambient-occlusion-shader";

/**
 * One bounded single-scattering shader, emitted for both native shader languages. It has `slots` light slots whatever
 * lights are near: each reads its light's type, shadow kind (`VOLUME_SHADOW_CODE`) and view or cascade count from
 * uniforms, and the march skips the slots past `volumeLightCount`, so only settings change the shader. The slots'
 * shadows are the light block's views of its atlas (`HapticLights`).
 */
export function volumetricShader(
  wgsl: boolean,
  slots: number,
  steps: number,
  localVolumes = false,
): string {
  const { v2, v3, v4, f, u, decl, field, texture, sample, uv } = syntax(wgsl);
  const m4 = wgsl ? "mat4x4f" : "mat4";
  const array = (type: string, name: string, count: number) =>
    wgsl
      ? `uniform ${name}: array<${type}, ${count}>;`
      : `uniform ${type} ${name}[${count}];`;
  const fn = (
    name: string,
    args: [string, string][],
    result: string,
    body: string,
  ) =>
    wgsl
      ? `fn ${name}(${args.map(([type, n]) => `${n}: ${type}`).join(",")}) -> ${result} { ${body} }`
      : `${result} ${name}(${args.map(([type, n]) => `${type} ${n}`).join(",")}) { ${body} }`;
  let header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("depthSampler")}
${field(m4, "inverseProjection")}${field(m4, "inverseView")}${field(m4, "volumeView")}
${field(v4, "volumeSettings")}${field(v4, "volumeCamera")}${field(v2, "volumeHeight")}
${field(v3, "volumeShadowOffset")}${field(f, "volumeLightCount")}
`;
  let functions = "",
    lighting = "";
  const integer = wgsl ? "i32" : "int";
  const loop = (name: string, end: string) =>
    `for (${wgsl ? `var ${name}: i32` : `int ${name}`} = 0; ${name} < ${end}; ${name}++)`;
  const localArray = (type: string, name: string) => wgsl
    ? `var ${name}: array<${type}, ${MAX_FOG_VOLUMES}>;`
    : `${type} ${name}[${MAX_FOG_VOLUMES}];`;
  let localSetup = "", localPick = "", localSample = "";
  if (localVolumes) {
    header += field(integer, "fogVolumeCount") +
      array(m4, "fogVolumeInverse", MAX_FOG_VOLUMES) +
      array(v4, "fogVolumeParameters", MAX_FOG_VOLUMES);
    functions += fn("fogRayInterval", [[v3, "o"], [v3, "d"], [f, "shape"], [f, "limit"]], v2, `
${decl(f, "entry", "0.0")}${decl(f, "exit", "limit")}
if (shape > 0.5) {
  ${decl(f, "a", "dot(d,d)")}${decl(f, "b", "dot(o,d)")}
  ${decl(f, "discriminant", "b*b-a*(dot(o,o)-1.0)")}
  if (a <= 0.0 || discriminant < 0.0) { return ${v2}(0.0); }
  ${decl(f, "root", "sqrt(discriminant)")}
  entry = max(entry, (-b-root)/a); exit = min(exit, (-b+root)/a);
} else {
  ${loop("axis", "3")} {
    if (abs(d[axis]) < 0.000000000001) {
      if (abs(o[axis]) > 1.0) { return ${v2}(0.0); }
    } else {
      ${decl(f, "a", "(-1.0-o[axis])/d[axis]")}
      ${decl(f, "b", "(1.0-o[axis])/d[axis]")}
      entry = max(entry, min(a,b)); exit = min(exit, max(a,b));
    }
  }
}
return ${v2}(entry, max(entry, exit));`);
    // Each crossed volume gets its own samples over its own chord, in proportion to the chord's length and at least
    // one where the budget allows: a short volume inside or beside a long one is never starved, and every sample is
    // fixed to its volume rather than to a distance from the eye. Optical depth adds up per volume, so overlaps stay exact.
    localSetup = `
${localArray(v3, "fogOrigins")}${localArray(v3, "fogDirections")}${localArray(v2, "fogRanges")}
${localArray(integer, "localCounts")}${localArray(integer, "localIndices")}${localArray(f, "localSegments")}
${decl(f, "localSpan", "0.0")}
${decl(integer, "crossed", "0")}
${loop("volume", u("fogVolumeCount"))} {
  fogOrigins[volume] = (${u("fogVolumeInverse")}[volume] * ${v4}(origin,1.0)).xyz;
  fogDirections[volume] = (${u("fogVolumeInverse")}[volume] * ${v4}(worldDirection,0.0)).xyz;
  fogRanges[volume] = fogRayInterval(fogOrigins[volume], fogDirections[volume], ${u("fogVolumeParameters")}[volume].z, depthLimit);
  if (fogRanges[volume].y > fogRanges[volume].x) { localSpan += fogRanges[volume].y - fogRanges[volume].x; crossed++; }
}
// With scene-wide fog the steps split evenly on every pixel of a scene with Fog Volumes, so no outline shows in it.
if (${u("volumeSettings")}.x > 0.0) { sceneSteps = ${Math.floor(steps / 2)}; } else { sceneSteps = 0; }
${decl(integer, "localBudget", `${steps} - sceneSteps`)}
${decl(integer, "spare", "localBudget - crossed")}
${loop("volume", u("fogVolumeCount"))} {
  localIndices[volume] = 0; localCounts[volume] = 0; localSegments[volume] = 0.0;
  ${decl(f, "chord", "fogRanges[volume].y - fogRanges[volume].x")}
  if (chord <= 0.0) { continue; }
  if (spare >= 0) { localCounts[volume] = 1 + ${integer}(floor(${f}(spare) * chord / localSpan)); }
  else { localCounts[volume] = ${integer}(floor(${f}(localBudget) * chord / localSpan)); }
  if (localCounts[volume] > 0) { localSegments[volume] = chord / ${f}(localCounts[volume]); }
}
`;
    localPick = `
${loop("volume", u("fogVolumeCount"))} {
  if (localIndices[volume] < localCounts[volume]) {
    ${decl(f, "localDistance", `fogRanges[volume].x + (${f}(localIndices[volume]) + 0.5) * localSegments[volume]`)}
    if (localDistance < rayDistance) { rayDistance = localDistance; segment = localSegments[volume]; picked = volume; }
  }
}
`;
    localSample = `
localIndices[picked] = localIndices[picked] + 1;
${decl(v3, "local", "fogOrigins[picked] + fogDirections[picked] * rayDistance")}
${decl(f, "boundary", "max(max(abs(local.x),abs(local.y)),abs(local.z))")}
if (${u("fogVolumeParameters")}[picked].z > 0.5) { boundary = length(local); }
if (boundary <= 1.0) {
  ${decl(f, "falloff", `${u("fogVolumeParameters")}[picked].y`)}
  ${decl(f, "weight", "1.0")}
  if (falloff > 0.0) { weight = smoothstep(0.0, falloff, 1.0-boundary); }
  density = ${u("fogVolumeParameters")}[picked].x * weight;
}
`;
  }
  const code = VOLUME_SHADOW_CODE;
  header += wgsl
    ? `${HAPTIC_LIGHTS_WGSL}var ${HAPTIC_SHADOW_ATLAS}Sampler: sampler_comparison; var ${HAPTIC_SHADOW_ATLAS}: texture_depth_2d;\n`
    : `${HAPTIC_LIGHTS_GLSL}uniform highp sampler2DShadow ${HAPTIC_SHADOW_ATLAS};\n`;
  // A slot's shadow (\`volumeShadow\`: kind, views, first view): a spot light's view, a point light's faces or the
  // sun's cascades, as the block draws them, at a position of the march (world space; the block's are rebased). On a
  // line of their own: Babylon splits a line's statements, which would end a comment after the uniforms at its first
  // semicolon.
  functions += "\n" + (wgsl ? hapticShadowWgsl(false) : hapticShadowGlsl(false)) + fn("volumeLightShadow", [[v4, "shadow"], [v3, "p"], [v3, "lightPosition"]], f, `
${decl(v3, "P", `p - ${u("volumeShadowOffset")}`)}
if (shadow.x < ${code.compare - 0.5}) { return 1.0; }
if (shadow.x < ${code.compare + 0.5}) { return hapticShadow(shadow.z, P, ${v3}(0.0), ${v3}(0.0)); }
if (shadow.x < ${code.cube + 0.5}) { return hapticPointShadow(${v4}(shadow.z, shadow.y, 0.0, 0.0), p - lightPosition, P); }
return hapticSunShadowFactor(P, ${v3}(0.0), ${v3}(0.0));`);
  for (let i = 0; i < slots; i++) {
    for (const name of ["volumePosition", "volumeDirection", "volumeColor"])
      header += field(v4, `${name}${i}`);
    header += field(v2, `volumeCone${i}`) + field(v2, `volumeDepth${i}`) + field(v4, `volumeShadow${i}`);
    // A slot's shadow: its light's views of the atlas, as the light block holds them.
    functions += fn(
      `visibility${i}`,
      [
        [v3, "p"],
        [f, "viewZ"],
      ],
      f,
      `return volumeLightShadow(${u(`volumeShadow${i}`)}, p, ${u(`volumePosition${i}`)}.xyz);`,
    );
    // Slots past the lights taking part this frame are skipped: one uniform branch per step.
    lighting += `if (${u("volumeLightCount")} > ${i}.5) {
${decl(v3, "toLight", `${u(`volumePosition${i}`)}.xyz - p`)}
${decl(f, "distanceToLight", "max(length(toLight), 0.001)")}
${decl(v3, "lightDirection", "toLight / distanceToLight")}
${decl(f, "attenuation", "1.0")}
if (${u(`volumePosition${i}`)}.w < 0.5) { lightDirection = -normalize(${u(`volumeDirection${i}`)}.xyz); }
else {
  attenuation = pow(clamp(1.0 - pow(distanceToLight / max(${u(`volumeColor${i}`)}.w, 0.001), 4.0), 0.0, 1.0), 2.0) / max(distanceToLight * distanceToLight, 0.25);
  if (${u(`volumePosition${i}`)}.w > 1.5) {
    ${decl(f, "cone", `dot(-lightDirection, normalize(${u(`volumeDirection${i}`)}.xyz))`)}
    attenuation *= smoothstep(${u(`volumeDirection${i}`)}.w, max(${u(`volumeDirection${i}`)}.w + 0.0001, ${u(`volumeCone${i}`)}.x), cone);
  }
}
${decl(f, "g", `${u("volumeSettings")}.w`)}
${decl(f, "phase", `(1.0-g*g) / (12.5663706 * pow(max(0.001, 1.0+g*g-2.0*g*dot(lightDirection, worldDirection)), 1.5))`)}
illumination += ${u(`volumeColor${i}`)}.rgb * (attenuation * phase * visibility${i}(p, abs((${u("volumeView")} * ${v4}(p,1.0)).z)));
}
`;
  }
  const body = `
${decl(f, "depth", `abs(${sample("depthSampler", uv)}.r)`)}
if (depth < 0.000001) { depth = ${u("volumeCamera")}.y; }
${decl(v2, "ndc", `${uv} * 2.0 - ${v2}(1.0)`)}
${decl(v4, "unprojected", `${u("inverseProjection")} * ${v4}(ndc, 0.5, 1.0)`)}
${decl(v3, "viewPoint", "unprojected.xyz / unprojected.w")}
${decl(v3, "viewDirection", "normalize(viewPoint)")}
${decl(v3, "viewOrigin", `${v3}(0.0)`)}
if (${u("volumeCamera")}.w > 0.5) {
  viewOrigin = ${v3}(viewPoint.xy, ${u("volumeCamera")}.x * ${u("volumeCamera")}.z);
  viewDirection = ${v3}(0.0, 0.0, ${u("volumeCamera")}.z);
}
${decl(v3, "origin", `(${u("inverseView")} * ${v4}(viewOrigin, 1.0)).xyz`)}
${decl(v3, "worldDirection", `normalize((${u("inverseView")} * ${v4}(viewDirection, 0.0)).xyz)`)}
// Fog Volumes reach the visible surface. Volumetric Distance bounds scene-wide fog only.
${decl(f, "depthLimit", "max(0.0, depth - abs(viewOrigin.z)) / max(abs(viewDirection.z), 0.0001)")}
${decl(f, "sceneSpan", "0.0")}
if (${u("volumeSettings")}.x > 0.0) { sceneSpan = min(${u("volumeSettings")}.z, depthLimit); }
${decl(integer, "sceneSteps", String(steps))}
${localSetup}
${decl(f, "sceneSegment", "0.0")}
if (sceneSteps > 0) { sceneSegment = sceneSpan / ${f}(sceneSteps); }
${decl(integer, "sceneIndex", "0")}
${decl(f, "transmittance", "1.0")}
${decl(v3, "scattering", `${v3}(0.0)`)}
// Scene-wide fog samples evenly to its span and each Fog Volume over its own chord. Each step takes the nearest next
// sample of all of them, so in-scattering is gathered front to back through every medium.
for (${wgsl ? "var step: i32 = 0" : "int step = 0"}; step < ${steps}; step++) {
  if (transmittance < 0.001) { break; }
  ${decl(f, "rayDistance", "1.0e30")}
  ${decl(f, "segment", "sceneSegment")}
  ${decl(integer, "picked", "-1")}
  if (sceneIndex < sceneSteps && sceneSpan > 0.0) { rayDistance = (${f}(sceneIndex) + 0.5) * sceneSegment; }
  ${localPick}
  if (rayDistance > 1.0e29) { break; }
  ${decl(f, "density", "0.0")}
  if (picked >= 0) {
    ${localSample}
  } else {
    sceneIndex++;
    // Scene-wide fog is full at and below its height and thins above it (volumeHeight: height, falloff per unit).
    ${decl(f, "aboveFogHeight", `max(0.0, origin.y + worldDirection.y * rayDistance - ${u("volumeHeight")}.x)`)}
    density = ${u("volumeSettings")}.x * exp(-aboveFogHeight * ${u("volumeHeight")}.y);
  }
  if (density <= 0.0) { continue; }
  ${decl(f, "extinction", "exp(-density * segment)")}
  ${decl(v3, "p", "origin + worldDirection * rayDistance")}
  ${decl(v3, "illumination", `${v3}(0.0)`)}
  ${lighting}
  scattering += transmittance * (1.0 - extinction) * illumination * ${u("volumeSettings")}.y;
  transmittance *= extinction;
}
${wgsl ? "fragmentOutputs.color" : "gl_FragColor"} = ${v4}(scattering, transmittance);
${wgsl ? "return fragmentOutputs;" : ""}`;
  return (
    header +
    functions +
    (wgsl
      ? `@fragment fn main(input: FragmentInputs) -> FragmentOutputs { ${body} }`
      : `void main() { ${body} }`)
  );
}

/** Four depth-weighted taps preserve edges when upsampling low-resolution fog. */
export function volumetricCompositeShader(
  wgsl: boolean,
  linear: boolean,
): string {
  const { v2, v3, v4, f, decl, sample, uv } = syntax(wgsl);
  const texel = wgsl ? "uniforms.fogTexelSize" : "fogTexelSize";
  const header = wgsl
    ? `varying vUV: vec2f; uniform fogTexelSize: vec2f; uniform cameraFar: f32;
${["textureSampler", "mainSampler", "depthSampler"].map((name) => `var ${name}: texture_2d<f32>; var ${name}Sampler: sampler;`).join("\n")}`
    : "varying vec2 vUV; uniform vec2 fogTexelSize; uniform float cameraFar; uniform sampler2D textureSampler; uniform sampler2D mainSampler; uniform sampler2D depthSampler;";
  const body = `
${decl(v4, "base", sample("mainSampler", uv))}
${decl(f, "depth", `min(abs(${sample("depthSampler", uv)}.r), 65000.0)`)}
if (depth < 0.000001) { depth = ${wgsl ? "uniforms.cameraFar" : "cameraFar"}; }
${decl(v2, "grid", `${uv} / ${texel} - ${v2}(0.5)`)}
${decl(v2, "fraction", "fract(grid)")}
${decl(v2, "start", `(floor(grid) + ${v2}(0.5)) * ${texel}`)}
${decl(v4, "fog", `${v4}(0.0)`)}
${decl(f, "total", "0.0")}
${[
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
]
  .map(
    ([x, y]) => `{
  ${decl(v2, "tap", `start + ${v2}(${x}.0, ${y}.0) * ${texel}`)}
  ${decl(f, "tapDepth", `min(abs(${sample("depthSampler", "tap")}.r), 65000.0)`)}
  if (tapDepth < 0.000001) { tapDepth = ${wgsl ? "uniforms.cameraFar" : "cameraFar"}; }
  ${decl(f, "weight", `${x ? "fraction.x" : "(1.0-fraction.x)"} * ${y ? "fraction.y" : "(1.0-fraction.y)"} / (1.0 + 100.0 * abs(tapDepth-depth) / max(depth, 0.1))`)}
  fog += ${sample("textureSampler", "tap")} * weight;
  total += weight;
}`,
  )
  .join("\n")}
fog /= max(total, 0.000001);
${decl(v3, "color", `${linear ? "base.rgb" : `pow(max(base.rgb, ${v3}(0.0)), ${v3}(2.2))`} * fog.a + fog.rgb`)}
${wgsl ? "fragmentOutputs.color" : "gl_FragColor"} = ${v4}(${linear ? "color" : `pow(max(color, ${v3}(0.0)), ${v3}(1.0/2.2))`}, base.a);
${wgsl ? "return fragmentOutputs;" : ""}`;
  return (
    header +
    (wgsl
      ? `@fragment fn main(input: FragmentInputs) -> FragmentOutputs { ${body} }`
      : `void main() { ${body} }`)
  );
}

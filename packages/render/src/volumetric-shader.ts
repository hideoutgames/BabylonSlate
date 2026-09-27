import type { VolumeShadow } from "./volumetric-lights";
import { MAX_FOG_VOLUMES } from "./fog-volumes";

/** One bounded single-scattering shader, emitted for both native shader languages. */
export function volumetricShader(
  wgsl: boolean,
  shadows: readonly VolumeShadow[],
  steps: number,
  halfZ: boolean,
  reverseZ: boolean,
  localVolumes = false,
): string {
  const v2 = wgsl ? "vec2f" : "vec2",
    v3 = wgsl ? "vec3f" : "vec3",
    v4 = wgsl ? "vec4f" : "vec4";
  const m4 = wgsl ? "mat4x4f" : "mat4",
    f = wgsl ? "f32" : "float";
  const u = (name: string) => (wgsl ? `uniforms.${name}` : name);
  const decl = (type: string, name: string, value: string) =>
    wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
  const uniform = (type: string, name: string) => `uniform ${name}: ${type};`;
  const field = (type: string, name: string) =>
    wgsl ? uniform(type, name) : `uniform ${type} ${name};`;
  const array = (type: string, name: string, count: number) =>
    wgsl
      ? uniform(`array<${type}, ${count}>`, name)
      : `uniform ${type} ${name}[${count}];`;
  const texture = (name: string, kind = "2d") =>
    wgsl
      ? `var ${name}: texture_${kind}<f32>; var ${name}Sampler: sampler;`
      : `uniform ${kind === "cube" ? "samplerCube" : "sampler2D"} ${name};`;
  const sample = (name: string, uv: string) =>
    wgsl
      ? `textureSampleLevel(${name}, ${name}Sampler, ${uv}, 0.0)`
      : `texture2D(${name}, ${uv})`;
  const fn = (
    name: string,
    args: [string, string][],
    result: string,
    body: string,
  ) =>
    wgsl
      ? `fn ${name}(${args.map(([type, n]) => `${n}: ${type}`).join(",")}) -> ${result} { ${body} }`
      : `${result} ${name}(${args.map(([type, n]) => `${type} ${n}`).join(",")}) { ${body} }`;
  const uv = wgsl ? "input.vUV" : "vUV";
  let header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("depthSampler")}
${field(m4, "inverseProjection")}${field(m4, "inverseView")}${field(m4, "volumeView")}
${field(v4, "volumeSettings")}${field(v4, "volumeCamera")}
${field(v3, "volumeShadowOffset")}
`;
  let functions = "",
    lighting = "";
  const integer = wgsl ? "i32" : "int";
  const loop = (name: string, end: string) =>
    `for (${wgsl ? `var ${name}: i32` : `int ${name}`} = 0; ${name} < ${end}; ${name}++)`;
  const localArray = (type: string, name: string) => wgsl
    ? `var ${name}: array<${type}, ${MAX_FOG_VOLUMES}>;`
    : `${type} ${name}[${MAX_FOG_VOLUMES}];`;
  let localSetup = "", localSample = "";
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
    localSetup = `
${localArray(v3, "fogOrigins")}${localArray(v3, "fogDirections")}
${localArray(v2, "fogRanges")}${localArray(v2, "occupiedRanges")}
${decl(integer, "occupiedCount", "0")}
${decl(integer, "occupiedIndex", "0")}${decl(f, "occupiedOffset", "0.0")}
${loop("volume", u("fogVolumeCount"))} {
  fogOrigins[volume] = (${u("fogVolumeInverse")}[volume] * ${v4}(origin,1.0)).xyz;
  fogDirections[volume] = (${u("fogVolumeInverse")}[volume] * ${v4}(worldDirection,0.0)).xyz;
  fogRanges[volume] = fogRayInterval(fogOrigins[volume], fogDirections[volume], ${u("fogVolumeParameters")}[volume].z, distanceLimit);
}
if (${u("volumeSettings")}.x <= 0.0) {
  // Sort and merge at most eight occupied intervals once per pixel. Marching
  // across their combined length does not waste the sample budget in gaps.
  ${loop("volume", u("fogVolumeCount"))} {
    ${decl(v2, "range", "fogRanges[volume]")}
    if (range.y <= range.x) { continue; }
    ${decl(integer, "position", "occupiedCount")}
    for (${wgsl ? "var previous: i32" : "int previous"} = occupiedCount-1; previous >= 0; previous--) {
      if (occupiedRanges[previous].x <= range.x) { break; }
      occupiedRanges[previous+1] = occupiedRanges[previous]; position = previous;
    }
    occupiedRanges[position] = range; occupiedCount++;
  }
  ${decl(integer, "mergedCount", "0")}
  ${loop("volume", "occupiedCount")} {
    ${decl(v2, "range", "occupiedRanges[volume]")}
    if (mergedCount > 0) {
      if (range.x <= occupiedRanges[mergedCount-1].y) {
        occupiedRanges[mergedCount-1].y = max(occupiedRanges[mergedCount-1].y, range.y);
        continue;
      }
    }
    occupiedRanges[mergedCount] = range; mergedCount++;
  }
  occupiedCount = mergedCount; distanceSpan = 0.0;
  ${loop("volume", "occupiedCount")} { distanceSpan += occupiedRanges[volume].y - occupiedRanges[volume].x; }
}
`;
    localSample = `
if (${u("volumeSettings")}.x <= 0.0) {
  ${loop("skip", String(MAX_FOG_VOLUMES))} {
    ${decl(f, "length", "occupiedRanges[occupiedIndex].y - occupiedRanges[occupiedIndex].x")}
    if (occupiedIndex+1 >= occupiedCount || rayDistance <= occupiedOffset+length) { break; }
    occupiedOffset += length; occupiedIndex++;
  }
  rayDistance = occupiedRanges[occupiedIndex].x + rayDistance - occupiedOffset;
}
${loop("volume", u("fogVolumeCount"))} {
  if (rayDistance < fogRanges[volume].x || rayDistance > fogRanges[volume].y) { continue; }
  ${decl(v3, "local", "fogOrigins[volume] + fogDirections[volume] * rayDistance")}
  ${decl(f, "boundary", "max(max(abs(local.x),abs(local.y)),abs(local.z))")}
  if (${u("fogVolumeParameters")}[volume].z > 0.5) { boundary = length(local); }
  if (boundary > 1.0) { continue; }
  ${decl(f, "falloff", `${u("fogVolumeParameters")}[volume].y`)}
  ${decl(f, "weight", "1.0")}
  if (falloff > 0.0) { weight = smoothstep(0.0, falloff, 1.0-boundary); }
  density += ${u("fogVolumeParameters")}[volume].x * weight;
}
`;
  }
  shadows.forEach((shadow, i) => {
    for (const name of ["volumePosition", "volumeDirection", "volumeColor"])
      header += field(v4, `${name}${i}`);
    header += field(v2, `volumeCone${i}`) + field(v2, `volumeDepth${i}`);
    const sampler = `shadowTexture${i}`;
    let visibility = "return 1.0;";
    if (shadow.kind === "cube") {
      header += texture(sampler, "cube");
      const sampled = wgsl
        ? `textureSampleLevel(${sampler}, ${sampler}Sampler, direction * ${v3}(1.0,-1.0,1.0), 0.0)`
        : `textureCube(${sampler}, direction * ${v3}(1.0,-1.0,1.0))`;
      visibility = `${decl(v3, "direction", `p - ${u(`volumePosition${i}`)}.xyz`)}
${decl(f, "metric", `(length(direction) + ${u(`volumeDepth${i}`)}.x) / max(${u(`volumeDepth${i}`)}.y, 0.0001)`)}
${decl(v4, "stored", sampled)}
${decl(f, "depth", shadow.packed ? `dot(stored, ${v4}(1.0/16581375.0,1.0/65025.0,1.0/255.0,1.0))` : "stored.r")}
if (metric > depth) { return 0.0; } return 1.0;`;
    } else if (shadow.kind !== "none") {
      const cascaded = shadow.kind === "cascades";
      header += wgsl
        ? `var ${sampler}: texture_depth_${cascaded ? "2d_array" : "2d"}; var ${sampler}Sampler: sampler_comparison;`
        : `uniform highp sampler${cascaded ? "2DArrayShadow" : "2DShadow"} ${sampler};`;
      header += cascaded
        ? array(m4, `lightMatrix${i}`, shadow.cascades) +
          array(f, `viewFrustumZ${i}`, shadow.cascades)
        : field(m4, `lightMatrix${i}`);
      const layer = wgsl ? "layer" : "float(layer)";
      const sampleCompare = wgsl
        ? `textureSampleCompareLevel(${sampler}, ${sampler}Sampler, coord.xy, ${cascaded ? `${layer},` : ""} coord.z)`
        : `texture(${sampler}, ${cascaded ? `vec4(coord.xy, ${layer}, coord.z)` : "coord"})`;
      visibility = cascaded
        ? `${decl(wgsl ? "i32" : "int", "layer", "0")}
${Array.from({ length: shadow.cascades - 1 }, (_, n) => `if (viewZ > ${u(`viewFrustumZ${i}`)}[${n}]) { layer = ${n + 1}; }`).join("\n")}
if (viewZ > ${u(`viewFrustumZ${i}`)}[${shadow.cascades - 1}]) { return 1.0; }
`
        : "";
      visibility += `${decl(v4, "projected", `${u(`lightMatrix${i}`)}${cascaded ? "[layer]" : ""} * ${v4}(p - ${u("volumeShadowOffset")}, 1.0)`)}
if (projected.w <= 0.0) { return 1.0; }
${decl(v3, "clip", "projected.xyz / projected.w")}
${decl(v3, "coord", `${v3}(clip.xy * 0.5 + ${v2}(0.5), ${halfZ ? "clip.z" : "clip.z * 0.5 + 0.5"})`)}
if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 || coord.z < 0.0 || coord.z > 1.0) { return 1.0; }
coord.z = clamp(coord.z ${reverseZ ? "+" : "-"} 0.0001, 0.0, 1.0);
return ${sampleCompare};`;
    }
    functions += fn(
      `visibility${i}`,
      [
        [v3, "p"],
        [f, "viewZ"],
      ],
      f,
      visibility,
    );
    lighting += `{
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
  });
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
${decl(f, "distanceLimit", `min(${u("volumeSettings")}.z, max(0.0, depth - abs(viewOrigin.z)) / max(abs(viewDirection.z), 0.0001))`)}
${decl(f, "distanceSpan", "distanceLimit")}
${localSetup}
${decl(f, "segment", `distanceSpan / ${f}(${steps})`)}
${localVolumes ? "" : decl(f, "extinction", `exp(-${u("volumeSettings")}.x * segment)`)}
${decl(f, "transmittance", "1.0")}
${decl(v3, "scattering", `${v3}(0.0)`)}
for (${wgsl ? "var step: i32 = 0" : "int step = 0"}; step < ${steps}; step++) {
  if (distanceSpan <= 0.0 || transmittance < 0.001) { break; }
  ${decl(f, "rayDistance", `(${f}(step) + 0.5) * segment`)}
  ${decl(f, "density", `${u("volumeSettings")}.x`)}
  ${localSample}
  if (density <= 0.0) { continue; }
  ${localVolumes ? decl(f, "extinction", "exp(-density * segment)") : ""}
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
  const v2 = wgsl ? "vec2f" : "vec2",
    v3 = wgsl ? "vec3f" : "vec3",
    v4 = wgsl ? "vec4f" : "vec4";
  const sample = (name: string, uv: string) =>
    wgsl
      ? `textureSampleLevel(${name}, ${name}Sampler, ${uv}, 0.0)`
      : `texture2D(${name}, ${uv})`;
  const decl = (type: string, name: string, value: string) =>
    wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
  const uv = wgsl ? "input.vUV" : "vUV",
    texel = wgsl ? "uniforms.fogTexelSize" : "fogTexelSize";
  const f = wgsl ? "f32" : "float";
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

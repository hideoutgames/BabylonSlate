/** Shared GLSL/WGSL syntax helpers for the ambient occlusion and temporal passes. */
export function syntax(wgsl: boolean) {
  const v2 = wgsl ? "vec2f" : "vec2",
    v3 = wgsl ? "vec3f" : "vec3",
    v4 = wgsl ? "vec4f" : "vec4",
    f = wgsl ? "f32" : "float";
  return {
    v2, v3, v4, f,
    uv: wgsl ? "input.vUV" : "vUV",
    u: (name: string) => (wgsl ? `uniforms.${name}` : name),
    decl: (type: string, name: string, value: string) =>
      wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`,
    field: (type: string, name: string) =>
      wgsl ? `uniform ${name}: ${type};` : `uniform ${type} ${name};`,
    texture: (name: string) =>
      wgsl
        ? `var ${name}: texture_2d<f32>; var ${name}Sampler: sampler;`
        : `uniform sampler2D ${name};`,
    sample: (name: string, at: string) =>
      wgsl
        ? `textureSampleLevel(${name}, ${name}Sampler, ${at}, 0.0)`
        : `texture2D(${name}, ${at})`,
    loop: (name: string, start: number, end: number) =>
      `for (${wgsl ? `var ${name}: i32` : `int ${name}`} = ${start}; ${name} < ${end}; ${name}++)`,
    output: (value: string) =>
      `${wgsl ? "fragmentOutputs.color" : "gl_FragColor"} = ${value}; return${wgsl ? " fragmentOutputs" : ""};`,
    main: (body: string) =>
      wgsl
        ? `@fragment fn main(input: FragmentInputs) -> FragmentOutputs { ${body} }`
        : `void main() { ${body} }`,
  };
}

/**
 * Normal-oriented hemisphere occlusion from the shared view-depth and encoded
 * world-normal geometry buffers. A golden-angle kernel rotated by interleaved
 * gradient noise avoids a random texture; the blur pass removes the pattern.
 *
 * Uniforms: `aoProjection`, `aoInverseProjection`, `aoView`,
 * `aoSettings` (radius, strength, max distance, depth bias),
 * `aoCamera` (handedness sign, orthographic flag) and `aoTexelSize`.
 */
export function ambientOcclusionShader(wgsl: boolean, samples: number): string {
  const { v2, v3, v4, f, uv, u, decl, field, texture, sample, loop, output, main } = syntax(wgsl);
  const header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("depthSampler")}${texture("normalSampler")}
${field(wgsl ? "mat4x4f" : "mat4", "aoProjection")}${field(wgsl ? "mat4x4f" : "mat4", "aoInverseProjection")}
${field(wgsl ? "mat4x4f" : "mat4", "aoView")}
${field(v4, "aoSettings")}${field(v2, "aoCamera")}${field(v2, "aoTexelSize")}
`;
  const body = `
${decl(f, "depth", `abs(${sample("depthSampler", uv)}.r)`)}
if (depth < 0.000001 || depth >= ${u("aoSettings")}.z) { ${output(`${v4}(1.0)`)} }
${decl(f, "radius", `${u("aoSettings")}.x`)}
${decl(v2, "ndc", `${uv} * 2.0 - ${v2}(1.0)`)}
${decl(v4, "unprojected", `${u("aoInverseProjection")} * ${v4}(ndc, 0.5, 1.0)`)}
${decl(v3, "viewPoint", "unprojected.xyz / unprojected.w")}
${decl(v3, "viewPosition", `viewPoint * (depth / max(abs(viewPoint.z), 0.000001))`)}
${decl(v3, "toCamera", "-viewPosition")}
if (${u("aoCamera")}.y > 0.5) {
  viewPosition = ${v3}(viewPoint.xy, depth * ${u("aoCamera")}.x);
  toCamera = ${v3}(0.0, 0.0, -${u("aoCamera")}.x);
}
${decl(v3, "worldNormal", `${sample("normalSampler", uv)}.xyz * 2.0 - ${v3}(1.0)`)}
if (dot(worldNormal, worldNormal) < 0.0001) { ${output(`${v4}(1.0)`)} }
${decl(v3, "surfaceNormal", `normalize((${u("aoView")} * ${v4}(normalize(worldNormal), 0.0)).xyz)`)}
if (dot(surfaceNormal, toCamera) < 0.0) { surfaceNormal = -surfaceNormal; }
${decl(v2, "pixel", `floor(${uv} / ${u("aoTexelSize")})`)}
${decl(f, "angle", "6.2831853 * fract(52.9829189 * fract(dot(pixel, " + v2 + "(0.06711056, 0.00583715))))")}
${decl(v3, "noise", `${v3}(cos(angle), sin(angle), 0.0)`)}
${decl(v3, "tangent", "noise - surfaceNormal * dot(noise, surfaceNormal)")}
if (dot(tangent, tangent) < 0.0001) { tangent = ${v3}(surfaceNormal.z, 0.0, -surfaceNormal.x); }
tangent = normalize(tangent);
${decl(v3, "bitangent", "cross(surfaceNormal, tangent)")}
${decl(f, "occlusion", "0.0")}
${loop("i", 0, samples)} {
  ${decl(f, "t", `(${f}(i) + 0.5) / ${f}(${samples})`)}
  ${decl(f, "phi", `${f}(i) * 2.3999632`)}
  ${decl(f, "sinTheta", "sqrt(t)")}
  ${decl(v3, "direction", `${v3}(cos(phi) * sinTheta, sin(phi) * sinTheta, sqrt(1.0 - t))`)}
  ${decl(v3, "offset", "tangent * direction.x + bitangent * direction.y + surfaceNormal * direction.z")}
  ${decl(v3, "samplePosition", `viewPosition + offset * (radius * mix(0.1, 1.0, t * t))`)}
  ${decl(v4, "clip", `${u("aoProjection")} * ${v4}(samplePosition, 1.0)`)}
  if (clip.w <= 0.000001) { continue; }
  ${decl(v2, "sampleUv", `clip.xy / clip.w * 0.5 + ${v2}(0.5)`)}
  if (sampleUv.x < 0.0 || sampleUv.y < 0.0 || sampleUv.x > 1.0 || sampleUv.y > 1.0) { continue; }
  ${decl(f, "sceneDepth", `abs(${sample("depthSampler", "sampleUv")}.r)`)}
  if (sceneDepth < 0.000001) { continue; }
  ${decl(f, "rangeWeight", "smoothstep(0.0, 1.0, radius / max(abs(depth - sceneDepth), 0.0001))")}
  occlusion += step(sceneDepth + ${u("aoSettings")}.w, abs(samplePosition.z)) * rangeWeight;
}
${decl(f, "visibility", `clamp(1.0 - ${u("aoSettings")}.y * occlusion / ${f}(${samples}), 0.0, 1.0)`)}
visibility = mix(visibility, 1.0, smoothstep(${u("aoSettings")}.z * 0.75, ${u("aoSettings")}.z, depth));
${output(`${v4}(visibility, visibility, visibility, 1.0)`)}
`;
  return header + main(body);
}

/**
 * Separable depth-aware blur at occlusion resolution. `aoBlurStep` is one
 * occlusion texel along the blur axis; taps across a depth edge are rejected.
 */
export function ambientOcclusionBlurShader(wgsl: boolean): string {
  const { v2, v4, f, uv, u, decl, field, texture, sample, loop, output, main } = syntax(wgsl);
  const header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("textureSampler")}${texture("depthSampler")}${field(v2, "aoBlurStep")}
`;
  const body = `
${decl(f, "centerDepth", `abs(${sample("depthSampler", uv)}.r)`)}
${decl(f, "total", "0.0")}
${decl(f, "weights", "0.0")}
${loop("i", -4, 5)} {
  ${decl(v2, "tap", `${uv} + ${u("aoBlurStep")} * ${f}(i)`)}
  ${decl(f, "tapDepth", `abs(${sample("depthSampler", "tap")}.r)`)}
  ${decl(f, "weight", `exp(-${f}(i * i) / 8.0) / (1.0 + 50.0 * abs(tapDepth - centerDepth) / max(centerDepth, 0.1))`)}
  total += ${sample("textureSampler", "tap")}.r * weight;
  weights += weight;
}
${decl(f, "visibility", "total / max(weights, 0.000001)")}
${output(`${v4}(visibility, visibility, visibility, 1.0)`)}
`;
  return header + main(body);
}

/**
 * Full-resolution composition: a depth-weighted four-tap upsample of the
 * blurred occlusion multiplies scene color in linear space.
 */
export function ambientOcclusionCompositeShader(wgsl: boolean, linear: boolean): string {
  const { v2, v3, v4, f, uv, u, decl, field, texture, sample, output, main } = syntax(wgsl);
  const header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("textureSampler")}${texture("mainSampler")}${texture("depthSampler")}
${field(v2, "aoTexelSize")}
`;
  const taps = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => `{
  ${decl(v2, "tap", `start + ${v2}(${x}.0, ${y}.0) * ${u("aoTexelSize")}`)}
  ${decl(f, "tapDepth", `abs(${sample("depthSampler", "tap")}.r)`)}
  ${decl(f, "weight", `${x ? "fraction.x" : "(1.0-fraction.x)"} * ${y ? "fraction.y" : "(1.0-fraction.y)"} / (1.0 + 100.0 * abs(tapDepth - depth) / max(depth, 0.1))`)}
  visibility += ${sample("textureSampler", "tap")}.r * weight;
  total += weight;
}`).join("\n");
  const body = `
${decl(v4, "base", sample("mainSampler", uv))}
${decl(f, "depth", `abs(${sample("depthSampler", uv)}.r)`)}
${decl(v2, "grid", `${uv} / ${u("aoTexelSize")} - ${v2}(0.5)`)}
${decl(v2, "fraction", "fract(grid)")}
${decl(v2, "start", `(floor(grid) + ${v2}(0.5)) * ${u("aoTexelSize")}`)}
${decl(f, "visibility", "0.0")}
${decl(f, "total", "0.0")}
${taps}
visibility = visibility / max(total, 0.000001);
if (depth < 0.000001) { visibility = 1.0; }
${decl(v3, "color", linear ? "base.rgb * visibility" : `pow(max(base.rgb, ${v3}(0.0)), ${v3}(2.2)) * visibility`)}
${output(`${v4}(${linear ? "color" : `pow(color, ${v3}(1.0 / 2.2))`}, base.a)`)}
`;
  return header + main(body);
}

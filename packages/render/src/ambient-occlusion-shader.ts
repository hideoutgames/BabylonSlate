/** Shared GLSL syntax helpers for the ambient occlusion and other spatial passes. */
export function syntax() {
  const v2 = "vec2",
    v3 = "vec3",
    v4 = "vec4",
    f = "float";
  return {
    v2, v3, v4, f,
    uv: "vUV",
    u: (name: string) => name,
    decl: (type: string, name: string, value: string) =>
      `${type} ${name} = ${value};`,
    field: (type: string, name: string) =>
      `uniform ${type} ${name};`,
    texture: (name: string) =>
      `uniform sampler2D ${name};`,
    /** One texel of the texture `name` in uv. */
    texelUv: (name: string) => `(1.0 / vec2(textureSize(${name}, 0)))`,
    sample: (name: string, at: string) =>
      `texture2D(${name}, ${at})`,
    loop: (name: string, start: number, end: number) =>
      `for (int ${name} = ${start}; ${name} < ${end}; ${name}++)`,
    output: (value: string) =>
      `gl_FragColor = ${value}; return;`,
    main: (body: string) =>
      `void main() { ${body} }`,
  };
}

/**
 * Normal-oriented hemisphere occlusion from the shared view-depth and encoded
 * world-normal geometry buffers. A golden-angle kernel rotated by interleaved
 * gradient noise avoids a random texture; the blur pass removes the pattern.
 * A sample is occluded when the surface its pixel shows lies in front of it,
 * rises above the centre's tangent planes, both the shaded normal's and the
 * face's from the depth beside it (so a face seen edge-on, or the next face
 * past a convex edge of a smooth-shaded low-poly mesh, never occludes), and
 * lies within twice the radius of the centre (so an object far in front
 * leaves no halo on the surface behind it).
 *
 * Uniforms: `aoProjection`, `aoInverseProjection`, `aoView`,
 * `aoSettings` (radius, strength, max distance, depth bias),
 * `aoCamera` (handedness sign, orthographic flag) and `aoTexelSize`.
 */
export function ambientOcclusionShader(samples: number): string {
  const { v2, v3, v4, f, uv, u, decl, field, texture, texelUv, sample, loop, output, main } = syntax();
  /** Declares `name`, the view-space point a depth texel at `at` shows, from its depth. */
  const point = (name: string, at: string, depth: string) => `
${decl(v4, `${name}Unprojected`, `${u("aoInverseProjection")} * ${v4}(${at} * 2.0 - ${v2}(1.0), 0.5, 1.0)`)}
${decl(v3, `${name}Ray`, `${name}Unprojected.xyz / ${name}Unprojected.w`)}
${decl(v3, name, `${name}Ray * (${depth} / max(abs(${name}Ray.z), 0.000001))`)}
if (${u("aoCamera")}.y > 0.5) { ${name} = ${v3}(${name}Ray.xy, ${depth} * ${u("aoCamera")}.x); }`;
  /** Declares the depth and view-space point of the depth texel `offset` texels from the centre's. */
  const neighbour = (name: string, offset: string) => `
${decl(f, `${name}Depth`, `abs(${sample("depthSampler", `centreUv + ${offset} * depthTexel`)}.r)`)}
${point(`${name}Point`, `(centreUv + ${offset} * depthTexel)`, `${name}Depth`)}`;
  const header = `varying vec2 vUV;
${texture("depthSampler")}${texture("normalSampler")}
${field("mat4", "aoProjection")}${field("mat4", "aoInverseProjection")}
${field("mat4", "aoView")}
${field(v4, "aoSettings")}${field(v2, "aoCamera")}${field(v2, "aoTexelSize")}
`;
  const body = `
// The depth is read nearest: each point lies on the ray through the centre of the depth texel it reads, as its depth
// does (seen edge-on, a surface's depth changes greatly within one texel).
${decl(v2, "depthTexel", texelUv("depthSampler"))}
${decl(v2, "centreUv", `(floor(${uv} / depthTexel) + ${v2}(0.5)) * depthTexel`)}
${decl(f, "depth", `abs(${sample("depthSampler", "centreUv")}.r)`)}
if (depth < 0.000001 || depth >= ${u("aoSettings")}.z) { ${output(`${v4}(1.0)`)} }
${decl(f, "radius", `${u("aoSettings")}.x`)}
${point("viewPosition", "centreUv", "depth")}
${decl(v3, "toCamera", "-viewPosition")}
if (${u("aoCamera")}.y > 0.5) { toCamera = ${v3}(0.0, 0.0, -${u("aoCamera")}.x); }
${decl(v3, "worldNormal", `${sample("normalSampler", uv)}.xyz * 2.0 - ${v3}(1.0)`)}
if (dot(worldNormal, worldNormal) < 0.0001) { ${output(`${v4}(1.0)`)} }
${decl(v3, "surfaceNormal", `normalize((${u("aoView")} * ${v4}(normalize(worldNormal), 0.0)).xyz)`)}
if (dot(surfaceNormal, toCamera) < 0.0) { surfaceNormal = -surfaceNormal; }
// The plane of the face the centre lies on, from the depth beside it: a low-poly mesh's smooth normal tilts by up to
// half the angle between its faces, so its tangent plane cuts through the faces beside a convex edge. Each axis takes
// the neighbour nearer in depth, which lies on the centre's face; either face of an edge keeps the other below it.
${neighbour("left", `${v2}(-1.0, 0.0)`)}
${neighbour("right", `${v2}(1.0, 0.0)`)}
${neighbour("down", `${v2}(0.0, -1.0)`)}
${neighbour("up", `${v2}(0.0, 1.0)`)}
${decl(v3, "alongX", "mix(viewPosition - leftPoint, rightPoint - viewPosition, step(abs(rightDepth - depth), abs(leftDepth - depth)))")}
${decl(v3, "alongY", "mix(viewPosition - downPoint, upPoint - viewPosition, step(abs(upDepth - depth), abs(downDepth - depth)))")}
${decl(v3, "faceNormal", "cross(alongX, alongY)")}
if (dot(faceNormal, faceNormal) < 1e-20) { faceNormal = surfaceNormal; }
faceNormal = normalize(faceNormal);
if (dot(faceNormal, toCamera) < 0.0) { faceNormal = -faceNormal; }
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
  ${decl(v2, "sceneUv", `(floor(sampleUv / depthTexel) + ${v2}(0.5)) * depthTexel`)}
  ${decl(f, "sceneDepth", `abs(${sample("depthSampler", "sceneUv")}.r)`)}
  if (sceneDepth < 0.000001) { continue; }
  // The surface point the sample's depth texel shows, in the same view space as the centre's.
  ${point("scenePoint", "sceneUv", "sceneDepth")}
  ${decl(v3, "toScene", "scenePoint - viewPosition")}
  ${decl(f, "sceneDistance", "length(toScene)")}
  // It occludes only where it rises above both the face's plane and the shaded normal's: the same surface seen
  // edge-on, whose depth changes by more than the bias between texels, lies in the first, and the plane of a coarse
  // depth (half float) is noisy where the shaded normal is not.
  ${decl(f, "rise", "smoothstep(0.15, 0.35, min(dot(toScene, surfaceNormal), dot(toScene, faceNormal)) / max(sceneDistance, 0.0001))")}
  // Within the radius in 3D, fading out by twice it: a surface far in front (another object) occludes nothing.
  ${decl(f, "rangeWeight", "1.0 - smoothstep(radius, 2.0 * radius, sceneDistance)")}
  occlusion += step(sceneDepth + ${u("aoSettings")}.w, abs(samplePosition.z)) * rise * rangeWeight;
}
${decl(f, "visibility", `clamp(1.0 - ${u("aoSettings")}.y * occlusion / ${f}(${samples}), 0.0, 1.0)`)}
visibility = mix(visibility, 1.0, smoothstep(${u("aoSettings")}.z * 0.75, ${u("aoSettings")}.z, depth));
${output(`${v4}(visibility, visibility, visibility, 1.0)`)}
`;
  return header + main(body);
}

/**
 * Ambient Occlusion's blur at `reduced` detail (`reducedOcclusion`): one depth-aware 3 × 3 pass at occlusion resolution
 * in place of the two separable ones, nine taps (and their depths) instead of eighteen. `aoBlurStep` is the tap
 * spacing on each axis (1.5 texels, so the bilinear taps reach as far as the separable pair's inner taps); a tap across
 * a depth edge is rejected as there.
 */
export function ambientOcclusionSquareBlurShader(): string {
  const { v2, v4, f, uv, u, decl, field, texture, sample, loop, output, main } = syntax();
  const header = `varying vec2 vUV;
${texture("textureSampler")}${texture("depthSampler")}${field(v2, "aoBlurStep")}
`;
  const body = `
${decl(f, "centerDepth", `abs(${sample("depthSampler", uv)}.r)`)}
${decl(f, "total", "0.0")}
${decl(f, "weights", "0.0")}
${loop("j", -1, 2)} {
  ${loop("i", -1, 2)} {
    ${decl(v2, "tap", `${uv} + ${u("aoBlurStep")} * ${v2}(${f}(i), ${f}(j))`)}
    ${decl(f, "tapDepth", `abs(${sample("depthSampler", "tap")}.r)`)}
    ${decl(f, "weight", `exp(-${f}(i * i + j * j) / 2.0) / (1.0 + 50.0 * abs(tapDepth - centerDepth) / max(centerDepth, 0.1))`)}
    total += ${sample("textureSampler", "tap")}.r * weight;
    weights += weight;
  }
}
${decl(f, "visibility", "total / max(weights, 0.000001)")}
${output(`${v4}(visibility, visibility, visibility, 1.0)`)}
`;
  return header + main(body);
}

/**
 * Separable depth-aware blur at occlusion resolution. `aoBlurStep` is one
 * occlusion texel along the blur axis; taps across a depth edge are rejected.
 */
export function ambientOcclusionBlurShader(): string {
  const { v2, v4, f, uv, u, decl, field, texture, sample, loop, output, main } = syntax();
  const header = `varying vec2 vUV;
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

import type { Matrix } from "@babylonjs/core/Maths/math.vector";

/**
 * Analytical unproject/project coefficients for standard perspective and orthographic
 * projection matrices (including off-center frustums), replacing per-pixel `mat4 * vec4`.
 *
 * For a UV in `[0, 1]^2` and positive view depth `d = abs(viewZ)`:
 * - `xy = uv * unproject.xy + unproject.zw`
 * - view-space position is `vec3(ortho ? xy : xy * d, d * zSign)`
 * And projecting view-space `p` back to `[0, 1]^2`:
 * - `clipW = ortho ? 1.0 : p.z * zSign`
 * - `uv = (ortho ? p.xy : p.xy / clipW) * project.xy + project.zw`
 */
export function projectionUnprojectParams(
  projection: Pick<Matrix, "m">,
  orthographic: boolean,
  rightHanded: boolean,
): {
  unproject: [number, number, number, number];
  project: [number, number, number, number];
  zSign: number;
} {
  const m = projection.m;
  if (orthographic) {
    const p00 = m[0] || 1;
    const p11 = m[5] || 1;
    const offX = m[12]!;
    const offY = m[13]!;
    return {
      unproject: [2 / p00, 2 / p11, (-1 - offX) / p00, (-1 - offY) / p11],
      project: [0.5 * p00, 0.5 * p11, 0.5 + 0.5 * offX, 0.5 + 0.5 * offY],
      zSign: rightHanded ? -1 : 1,
    };
  }
  const p23 = m[11] || (rightHanded ? -1 : 1);
  const zSign = p23 < 0 ? -1 : 1;
  const absP23 = Math.abs(p23);
  const p00 = (m[0] || 1) / absP23;
  const p11 = (m[5] || 1) / absP23;
  const offX = m[8]! / p23;
  const offY = m[9]! / p23;
  return {
    unproject: [2 / p00, 2 / p11, (-1 - offX) / p00, (-1 - offY) / p11],
    project: [0.5 * p00, 0.5 * p11, 0.5 + 0.5 * offX, 0.5 + 0.5 * offY],
    zSign,
  };
}

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
 * Uniforms: `aoProject`, `aoUnproject`, `aoView`,
 * `aoSettings` (radius, strength, max distance, depth bias),
 * `aoCamera` (handedness sign, orthographic flag) and `aoTexelSize`.
 */
export function ambientOcclusionShader(samples: number): string {
  const { v2, v3, v4, f, uv, u, decl, field, texture, texelUv, sample, loop, output, main } = syntax();
  const kernelEntries = Array.from({ length: samples }, (_, i) => {
    const t = (i + 0.5) / samples;
    const phi = i * 2.3999632;
    const sinTheta = Math.sqrt(t);
    const scale = 0.1 + 0.9 * t * t;
    const x = Math.cos(phi) * sinTheta * scale;
    const y = Math.sin(phi) * sinTheta * scale;
    const z = Math.sqrt(1 - t) * scale;
    return `vec3(${x.toFixed(6)}, ${y.toFixed(6)}, ${z.toFixed(6)})`;
  }).join(", ");
  /** Declares `name`, the view-space point a depth texel at `at` shows, from its depth. */
  const point = (name: string, at: string, depth: string) =>
    decl(v3, name, `aoUnprojectPoint(${at}, ${depth})`);
  /** Declares the depth and view-space point of the depth texel `offset` texels from the centre's. */
  const neighbour = (name: string, offset: string) => `
${decl(f, `${name}Depth`, `abs(${sample("depthSampler", `centreUv + ${offset} * depthTexel`)}.r)`)}
${point(`${name}Point`, `(centreUv + ${offset} * depthTexel)`, `${name}Depth`)}`;
  const header = `varying vec2 vUV;
${texture("depthSampler")}${texture("normalSampler")}
${field(v4, "aoProject")}${field(v4, "aoUnproject")}
${field("mat4", "aoView")}
${field(v4, "aoSettings")}${field(v2, "aoCamera")}${field(v2, "aoTexelSize")}
const vec3 aoKernel[${samples}] = vec3[${samples}](${kernelEntries});
vec3 aoUnprojectPoint(vec2 at, float d) {
  vec2 xy = at * aoUnproject.xy + aoUnproject.zw;
  return vec3(aoCamera.y > 0.5 ? xy : xy * d, d * aoCamera.x);
}
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
  ${decl(v3, "k", "aoKernel[i]")}
  ${decl(v3, "samplePosition", "viewPosition + (tangent * k.x + bitangent * k.y + surfaceNormal * k.z) * radius")}
  ${decl(f, "clipW", `${u("aoCamera")}.y > 0.5 ? 1.0 : samplePosition.z * ${u("aoCamera")}.x`)}
  if (clipW <= 0.000001) { continue; }
  ${decl(v2, "sampleUv", `(${u("aoCamera")}.y > 0.5 ? samplePosition.xy : samplePosition.xy / clipW) * ${u("aoProject")}.xy + ${u("aoProject")}.zw`)}
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
 * Separable depth-aware blur at occlusion resolution. `aoBlurStep` is one
 * occlusion texel along the blur axis; taps across a depth edge are rejected.
 */
export function ambientOcclusionBlurShader(): string {
  const { v2, v4, f, uv, u, decl, field, texture, sample, output, main } = syntax();
  const header = `varying vec2 vUV;
${texture("textureSampler")}${texture("depthSampler")}${field(v2, "aoBlurStep")}
`;
  const taps = [-4, -3, -2, -1, 1, 2, 3, 4]
    .map((offset) => {
      const spatial = Math.exp(-(offset * offset) / 8).toFixed(7);
      return `{
  ${decl(v2, "tap", `${uv} + ${u("aoBlurStep")} * ${offset.toFixed(1)}`)}
  ${decl(f, "tapDepth", `abs(${sample("depthSampler", "tap")}.r)`)}
  ${decl(f, "weight", `${spatial} / (1.0 + abs(tapDepth - centerDepth) * invCenter)`)}
  total += ${sample("textureSampler", "tap")}.r * weight;
  weights += weight;
}`;
    })
    .join("\n");
  const body = `
${decl(f, "centerDepth", `abs(${sample("depthSampler", uv)}.r)`)}
${decl(f, "invCenter", "50.0 / max(centerDepth, 0.1)")}
${decl(f, "total", `${sample("textureSampler", uv)}.r`)}
${decl(f, "weights", "1.0")}
${taps}
${decl(f, "visibility", "total / max(weights, 0.000001)")}
${output(`${v4}(visibility, visibility, visibility, 1.0)`)}
`;
  return header + main(body);
}

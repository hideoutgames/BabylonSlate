import type { VolumeShadow } from "./volumetric-lights";

/** One bounded single-scattering shader, emitted for both native shader languages. */
export function volumetricShader(wgsl: boolean, shadows: readonly VolumeShadow[], steps: number, halfZ: boolean, reverseZ: boolean): string {
  const v2 = wgsl ? "vec2f" : "vec2", v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4";
  const m4 = wgsl ? "mat4x4f" : "mat4", f = wgsl ? "f32" : "float";
  const u = (name: string) => wgsl ? `uniforms.${name}` : name;
  const decl = (type: string, name: string, value: string) => wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
  const uniform = (type: string, name: string) => `uniform ${name}: ${type};`;
  const field = (type: string, name: string) => wgsl ? uniform(type, name) : `uniform ${type} ${name};`;
  const array = (type: string, name: string, count: number) => wgsl ? uniform(`array<${type}, ${count}>`, name) : `uniform ${type} ${name}[${count}];`;
  const texture = (name: string, kind = "2d") => wgsl
    ? `var ${name}: texture_${kind}<f32>; var ${name}Sampler: sampler;`
    : `uniform ${kind === "cube" ? "samplerCube" : "sampler2D"} ${name};`;
  const sample = (name: string, uv: string) => wgsl ? `textureSampleLevel(${name}, ${name}Sampler, ${uv}, 0.0)` : `texture2D(${name}, ${uv})`;
  const fn = (name: string, args: [string, string][], result: string, body: string) => wgsl
    ? `fn ${name}(${args.map(([type, n]) => `${n}: ${type}`).join(",")}) -> ${result} { ${body} }`
    : `${result} ${name}(${args.map(([type, n]) => `${type} ${n}`).join(",")}) { ${body} }`;
  const uv = wgsl ? "input.vUV" : "vUV";
  let header = `${wgsl ? "varying vUV: vec2f;" : "varying vec2 vUV;"}
${texture("depthSampler")}
${field(m4, "inverseProjection")}${field(m4, "inverseView")}${field(m4, "volumeView")}
${field(v4, "volumeSettings")}${field(v4, "volumeCamera")}
`;
  let functions = "", lighting = "";
  shadows.forEach((shadow, i) => {
    for (const name of ["volumePosition", "volumeDirection", "volumeColor"]) header += field(v4, `${name}${i}`);
    header += field(v2, `volumeCone${i}`) + field(v2, `volumeDepth${i}`);
    const sampler = `shadowTexture${i}`;
    let visibility = "return 1.0;";
    if (shadow.kind === "cube") {
      header += texture(sampler, "cube");
      const sampled = wgsl ? `textureSampleLevel(${sampler}, ${sampler}Sampler, direction * ${v3}(1.0,-1.0,1.0), 0.0)` : `textureCube(${sampler}, direction * ${v3}(1.0,-1.0,1.0))`;
      visibility = `${decl(v3, "direction", `p - ${u(`volumePosition${i}`)}.xyz`)}
${decl(f, "metric", `(length(direction) + ${u(`volumeDepth${i}`)}.x) / max(${u(`volumeDepth${i}`)}.y, 0.0001)`)}
${decl(v4, "stored", sampled)}
${decl(f, "depth", shadow.packed ? `dot(stored, ${v4}(1.0/16581375.0,1.0/65025.0,1.0/255.0,1.0))` : "stored.r")}
if (metric > depth) { return 0.0; } return 1.0;`;
    } else if (shadow.kind !== "none") {
      const cascaded = shadow.kind === "cascades";
      header += wgsl ? `var ${sampler}: texture_depth_${cascaded ? "2d_array" : "2d"}; var ${sampler}Sampler: sampler_comparison;`
        : `uniform highp sampler${cascaded ? "2DArrayShadow" : "2DShadow"} ${sampler};`;
      header += cascaded ? array(m4, `lightMatrix${i}`, shadow.cascades) + array(f, `viewFrustumZ${i}`, shadow.cascades) : field(m4, `lightMatrix${i}`);
      const layer = wgsl ? "layer" : "float(layer)";
      const sampleCompare = wgsl ? `textureSampleCompareLevel(${sampler}, ${sampler}Sampler, coord.xy, ${cascaded ? `${layer},` : ""} coord.z)`
        : `texture(${sampler}, ${cascaded ? `vec4(coord.xy, ${layer}, coord.z)` : "coord"})`;
      visibility = cascaded ? `${decl(wgsl ? "i32" : "int", "layer", "0")}
${Array.from({ length: shadow.cascades - 1 }, (_, n) => `if (viewZ > ${u(`viewFrustumZ${i}`)}[${n}]) { layer = ${n + 1}; }`).join("\n")}
if (viewZ > ${u(`viewFrustumZ${i}`)}[${shadow.cascades - 1}]) { return 1.0; }
` : "";
      visibility += `${decl(v4, "projected", `${u(`lightMatrix${i}`)}${cascaded ? "[layer]" : ""} * ${v4}(p, 1.0)`)}
if (projected.w <= 0.0) { return 1.0; }
${decl(v3, "clip", "projected.xyz / projected.w")}
${decl(v3, "coord", `${v3}(clip.xy * 0.5 + ${v2}(0.5), ${halfZ ? "clip.z" : "clip.z * 0.5 + 0.5"})`)}
if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 || coord.z < 0.0 || coord.z > 1.0) { return 1.0; }
coord.z = clamp(coord.z ${reverseZ ? "+" : "-"} 0.0001, 0.0, 1.0);
return ${sampleCompare};`;
    }
    functions += fn(`visibility${i}`, [[v3, "p"], [f, "viewZ"]], f, visibility);
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
${decl(f, "phase", `(1.0-g*g) / (12.5663706 * pow(max(0.001, 1.0+g*g-2.0*g*dot(lightDirection, -worldDirection)), 1.5))`)}
illumination += ${u(`volumeColor${i}`)}.rgb * (attenuation * phase * visibility${i}(p, abs((${u("volumeView")} * ${v4}(p,1.0)).z)));
}
`;
  });
  const body = `
${decl(f, "depth", `abs(${sample("depthSampler", uv)}.r)`)}
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
${decl(f, "segment", `distanceLimit / ${f}(${steps})`)}
${decl(f, "extinction", `exp(-${u("volumeSettings")}.x * segment)`)}
${decl(f, "transmittance", "1.0")}
${decl(v3, "scattering", `${v3}(0.0)`)}
for (${wgsl ? "var step: i32 = 0" : "int step = 0"}; step < ${steps}; step++) {
  ${decl(v3, "p", `origin + worldDirection * ((${f}(step) + 0.5) * segment)`)}
  ${decl(v3, "illumination", `${v3}(0.0)`)}
  ${lighting}
  scattering += transmittance * (1.0 - extinction) * illumination * ${u("volumeSettings")}.y;
  transmittance *= extinction;
}
${wgsl ? "fragmentOutputs.color" : "gl_FragColor"} = ${v4}(scattering, transmittance);
${wgsl ? "return fragmentOutputs;" : ""}`;
  return header + functions + (wgsl ? `@fragment fn main(input: FragmentInputs) -> FragmentOutputs { ${body} }` : `void main() { ${body} }`);
}

/** Four depth-weighted taps preserve edges when upsampling low-resolution fog. */
export function volumetricCompositeShader(wgsl: boolean, linear: boolean): string {
  const v2 = wgsl ? "vec2f" : "vec2", v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4";
  const sample = (name: string, uv: string) => wgsl ? `textureSampleLevel(${name}, ${name}Sampler, ${uv}, 0.0)` : `texture2D(${name}, ${uv})`;
  const decl = (type: string, name: string, value: string) => wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
  const uv = wgsl ? "input.vUV" : "vUV", texel = wgsl ? "uniforms.fogTexelSize" : "fogTexelSize";
  const f = wgsl ? "f32" : "float";
  const header = wgsl ? `varying vUV: vec2f; uniform fogTexelSize: vec2f;
${["textureSampler", "mainSampler", "depthSampler"].map((name) => `var ${name}: texture_2d<f32>; var ${name}Sampler: sampler;`).join("\n")}`
    : "varying vec2 vUV; uniform vec2 fogTexelSize; uniform sampler2D textureSampler; uniform sampler2D mainSampler; uniform sampler2D depthSampler;";
  const body = `
${decl(v4, "base", sample("mainSampler", uv))}
${decl(f, "depth", `min(abs(${sample("depthSampler", uv)}.r), 65000.0)`)}
${decl(v2, "grid", `${uv} / ${texel} - ${v2}(0.5)`)}
${decl(v2, "fraction", "fract(grid)")}
${decl(v2, "start", `(floor(grid) + ${v2}(0.5)) * ${texel}`)}
${decl(v4, "fog", `${v4}(0.0)`)}
${decl(f, "total", "0.0")}
${[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => `{
  ${decl(v2, "tap", `start + ${v2}(${x}.0, ${y}.0) * ${texel}`)}
  ${decl(f, "tapDepth", `min(abs(${sample("depthSampler", "tap")}.r), 65000.0)`)}
  ${decl(f, "weight", `${x ? "fraction.x" : "(1.0-fraction.x)"} * ${y ? "fraction.y" : "(1.0-fraction.y)"} / (1.0 + 100.0 * abs(tapDepth-depth) / max(depth, 0.1))`)}
  fog += ${sample("textureSampler", "tap")} * weight;
  total += weight;
}`).join("\n")}
fog /= max(total, 0.000001);
${decl(v3, "color", `${linear ? "base.rgb" : `pow(max(base.rgb, ${v3}(0.0)), ${v3}(2.2))`} * fog.a + fog.rgb`)}
${wgsl ? "fragmentOutputs.color" : "gl_FragColor"} = ${v4}(${linear ? "color" : `pow(max(color, ${v3}(0.0)), ${v3}(1.0/2.2))`}, base.a);
${wgsl ? "return fragmentOutputs;" : ""}`;
  return header + (wgsl ? `@fragment fn main(input: FragmentInputs) -> FragmentOutputs { ${body} }` : `void main() { ${body} }`);
}

// The reflection term's includes, which Babylon's own combiner draws from the shader store.
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
import "@babylonjs/core/Shaders/ShadersInclude/pbrBRDFFunctions";
import "@babylonjs/core/Shaders/ShadersInclude/screenSpaceRayTrace";

/** What one scene effects compose applies: the effects of the plan composed onto the scene colour. */
export interface SpatialComposeTerms {
  ambientOcclusion: boolean;
  /** Real-Time Reflections, with the camera's projection kind and the scene's handedness. */
  reflections: { orthographic: boolean; rightHanded: boolean } | null;
  volumetricLighting: boolean;
  /** Scene Linear colour; Display Space decodes and encodes it with the 2.2 power. */
  linear: boolean;
}

/** A depth-weighted four-tap upsample of `sampler` (at `texel`) around the full-resolution pixel of depth `depth`. */
function upsampleTaps(texel: string, read: (at: string) => string, tapDepth: (at: string) => string, add: string): string {
  return [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => `{
  vec2 tap = start + vec2(${x}.0, ${y}.0) * ${texel};
  ${tapDepth("tap")}
  float weight = ${x ? "fraction.x" : "(1.0-fraction.x)"} * ${y ? "fraction.y" : "(1.0-fraction.y)"} / (1.0 + 100.0 * abs(tapDepth - depth) / max(depth, 0.1));
  ${add.replace("$value", read("tap"))}
  total += weight;
}`).join("\n");
}

/**
 * The one full-resolution pass composing ambient occlusion, Real-Time Reflections and volumetric lighting onto the
 * scene colour (`textureSampler`), in that order, in linear colour: occlusion multiplies it, the reflection blends
 * over it by Fresnel where the surface reflects, and the fog attenuates and adds. Each term is the one its own pass
 * applied before the passes merged: the occlusion's and fog's depth-weighted four-tap upsamples of their
 * reduced-resolution results (`aoSampler`, `fogSampler`) and Babylon's reflection combiner (`reflectionSampler`, its
 * blurred trace of the scene colour before occlusion). Only the colour between them no longer passes through a
 * half-float target, nor, in Display Space, through the 2.2 power between each term.
 *
 * Uniforms: `aoTexelSize`; `reflectionTerms` (strength, specular falloff exponent, reflectivity threshold),
 * `projection`, `invProjectionMatrix`, `view`; `fogTexelSize`, `cameraFar`, `fogActive` (0 while the march idles: its
 * target then holds nothing to read).
 */
export function spatialComposeShader(terms: SpatialComposeTerms): string {
  const { ambientOcclusion: ao, reflections, volumetricLighting: fog, linear } = terms;
  const declarations = ["varying vec2 vUV;", "uniform sampler2D textureSampler;", "uniform sampler2D depthSampler;"];
  if (ao) declarations.push("uniform sampler2D aoSampler;", "uniform vec2 aoTexelSize;");
  if (fog) declarations.push("uniform sampler2D fogSampler;", "uniform vec2 fogTexelSize;", "uniform float cameraFar;", "uniform float fogActive;");
  if (reflections) {
    if (reflections.orthographic) declarations.unshift("#define ORTHOGRAPHIC_CAMERA");
    if (reflections.rightHanded) declarations.unshift("#define SSRAYTRACE_RIGHT_HANDED_SCENE");
    declarations.push(
      "uniform sampler2D reflectionSampler;", "uniform sampler2D normalSampler;", "uniform sampler2D reflectivitySampler;",
      "uniform vec4 reflectionTerms;", "uniform mat4 projection;", "uniform mat4 invProjectionMatrix;", "uniform mat4 view;",
      "#include<helperFunctions>", "#include<pbrBRDFFunctions>", "#include<screenSpaceRayTrace>",
    );
  }
  // Display Space reflections alone leave a pixel that does not reflect as it was, unconverted (Babylon's combiner).
  const reflectionsAlone = !!reflections && !ao && !fog;
  const body: string[] = ["vec4 base = texture2D(textureSampler, vUV);"];
  if (reflections)
    body.push(`vec4 reflectivity = texture2D(reflectivitySampler, vUV);
bool reflects = max(reflectivity.r, max(reflectivity.g, reflectivity.b)) > reflectionTerms.z;`);
  if (reflectionsAlone) body.push("if (!reflects) { gl_FragColor = base; return; }");
  body.push(`vec3 color = ${linear ? "base.rgb" : reflectionsAlone ? "pow(base.rgb, vec3(2.2))" : "pow(max(base.rgb, vec3(0.0)), vec3(2.2))"};`);
  if (ao)
    body.push(`{
float depth = abs(texture2D(depthSampler, vUV).r);
vec2 grid = vUV / aoTexelSize - vec2(0.5);
vec2 fraction = fract(grid);
vec2 start = (floor(grid) + vec2(0.5)) * aoTexelSize;
float visibility = 0.0;
float total = 0.0;
${upsampleTaps("aoTexelSize", (at) => `texture2D(aoSampler, ${at}).r`, (at) => `float tapDepth = abs(texture2D(depthSampler, ${at}).r);`, "visibility += $value * weight;")}
visibility = visibility / max(total, 0.000001);
if (depth < 0.000001) { visibility = 1.0; }
color *= visibility;
}`);
  if (reflections)
    body.push(`if (reflects) {
vec3 SSR = texture2D(reflectionSampler, vUV).rgb;
vec2 texSize = vec2(textureSize(depthSampler, 0));
vec3 csNormal = texelFetch(normalSampler, ivec2(vUV * texSize), 0).xyz;
csNormal = csNormal * 2.0 - 1.0;
csNormal = (view * vec4(csNormal, 0.0)).xyz;
float depth = texelFetch(depthSampler, ivec2(vUV * texSize), 0).r;
vec3 csPosition = computeViewPosFromUVDepth(vUV, depth, projection, invProjectionMatrix);
// An orthographic camera's view rays are parallel, as its trace takes them.
vec3 csViewDirection = ${reflections.orthographic ? "normalize(vec3(0.0, 0.0, csPosition.z))" : "normalize(csPosition)"};
vec3 F0 = reflectivity.rgb;
vec3 fresnel = fresnelSchlickGGX(max(dot(csNormal, -csViewDirection), 0.0), F0, vec3(1.0));
vec3 reflectionMultiplier = clamp(pow(fresnel * reflectionTerms.x, vec3(reflectionTerms.y)), 0.0, 1.0);
color = color * (1.0 - reflectionMultiplier) + SSR * reflectionMultiplier;
}`);
  if (fog)
    body.push(`if (fogActive > 0.5) {
float depth = min(abs(texture2D(depthSampler, vUV).r), 65000.0);
if (depth < 0.000001) { depth = cameraFar; }
vec2 grid = vUV / fogTexelSize - vec2(0.5);
vec2 fraction = fract(grid);
vec2 start = (floor(grid) + vec2(0.5)) * fogTexelSize;
vec4 fog = vec4(0.0);
float total = 0.0;
${upsampleTaps("fogTexelSize", (at) => `texture2D(fogSampler, ${at})`, (at) => `float tapDepth = min(abs(texture2D(depthSampler, ${at}).r), 65000.0);
  if (tapDepth < 0.000001) { tapDepth = cameraFar; }`, "fog += $value * weight;")}
fog /= max(total, 0.000001);
color = color * fog.a + fog.rgb;
}`);
  const encoded = linear ? "color" : fog ? "pow(max(color, vec3(0.0)), vec3(1.0 / 2.2))" : "pow(color, vec3(1.0 / 2.2))";
  body.push(`gl_FragColor = vec4(${encoded}, base.a);`);
  return `${declarations.join("\n")}\nvoid main() {\n${body.join("\n")}\n}\n`;
}

import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { selectionVertexShader } from "@babylonjs/core/Shaders/selection.vertex";
import { selectionVertexShaderWGSL } from "@babylonjs/core/ShadersWGSL/selection.vertex";
import "@babylonjs/core/Shaders/selection.fragment";
import "@babylonjs/core/ShadersWGSL/selection.fragment";
import "@babylonjs/core/Shaders/postprocess.vertex";
import "@babylonjs/core/ShadersWGSL/postprocess.vertex";
import { SHARED_OUTLINE_ATTRIBUTE, SHARED_OUTLINE_MAX_WIDTH } from "./shared-outline";

export const SHARED_OUTLINE_MASK_SHADER = "babylonSlateSharedOutlineMask";
export const SHARED_OUTLINE_COMPOSE_SHADER = "babylonSlateSharedOutlineCompose";

function maskVertex(source: string, wgsl: boolean): string {
  const vec2 = wgsl ? "vec2f" : "vec2", vec4 = wgsl ? "vec4f" : "vec4";
  const vertex = wgsl ? "vertexInputs." : "", output = wgsl ? "vertexOutputs." : "", uniform = wgsl ? "uniforms." : "";
  const declarations = wgsl ? `
#ifdef VERTEXALPHA
attribute color: vec4f;
#endif
#ifdef SLATE_VERTEX_ALPHA
varying vOutlineAlpha: f32;
#endif
#ifdef SLATE_OPACITY
uniform opacityMatrix: mat4x4f;
varying vOutlineOpacityUV: vec2f;
#endif
` : `
#ifdef VERTEXALPHA
attribute vec4 color;
#endif
#ifdef SLATE_VERTEX_ALPHA
varying float vOutlineAlpha;
#endif
#ifdef SLATE_OPACITY
uniform mat4 opacityMatrix;
varying vec2 vOutlineOpacityUV;
#endif
`;
  return declarations + source.replaceAll("instanceSelectionId", SHARED_OUTLINE_ATTRIBUTE)
    .replaceAll("#ifdef INSTANCES", "#if defined(INSTANCES) && !defined(THIN_INSTANCES)")
    .replace(`#ifdef UV1\n${output}vUV=`, `#ifdef SLATE_DIFFUSE_UV1\n${output}vUV=`)
    .replace(`#ifdef UV2\n${output}vUV=`, `#ifdef SLATE_DIFFUSE_UV2\n${output}vUV=`)
    .replace("#include<morphTargetsVertexGlobal>", `#ifdef VERTEXALPHA\n${wgsl ? "var colorUpdated: vec4f" : "vec4 colorUpdated"}=${vertex}color;\n#endif\n#include<morphTargetsVertexGlobal>`)
    // World materials use zero for a missing requested UV set. Stock selection
    // instead substitutes UV2, which can invent cutout holes in the mask.
    .replace("#include<clipPlaneVertex>", `#if defined(ALPHATEST) && !defined(SLATE_DIFFUSE_UV1) && !defined(SLATE_DIFFUSE_UV2)\n${wgsl
      ? "vertexOutputs.vUV=(uniforms.diffuseMatrix*vec4f(0.0,0.0,1.0,0.0)).xy;"
      : "vUV=vec2(diffuseMatrix*vec4(0.0,0.0,1.0,0.0));"}
#endif
#ifdef SLATE_OPACITY
#ifdef SLATE_OPACITY_UV1
${output}vOutlineOpacityUV=(${uniform}opacityMatrix*${vec4}(uvUpdated,1.0,0.0)).xy;
#elif defined(SLATE_OPACITY_UV2)
${output}vOutlineOpacityUV=(${uniform}opacityMatrix*${vec4}(uv2Updated,1.0,0.0)).xy;
#else
${output}vOutlineOpacityUV=(${uniform}opacityMatrix*${vec4}(${vec2}(0.0),1.0,0.0)).xy;
#endif
#endif
#ifdef SLATE_VERTEX_ALPHA
${output}vOutlineAlpha=1.0;
#ifdef VERTEXALPHA
${output}vOutlineAlpha*=colorUpdated.a;
#endif
#ifdef INSTANCESCOLOR
${output}vOutlineAlpha*=${vertex}instanceColor.a;
#endif
#endif
#include<clipPlaneVertex>`);
}

/** Native deformation with owned regular-instance IDs and whole-actor thin IDs. */
export function registerSharedOutlineShaders(): void {
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_MASK_SHADER}VertexShader`] =
    maskVertex(selectionVertexShader.shader, false);
  ShaderStore.ShadersStoreWGSL[`${SHARED_OUTLINE_MASK_SHADER}VertexShader`] =
    maskVertex(selectionVertexShaderWGSL.shader, true);
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_MASK_SHADER}PixelShader`] = `
#if defined(INSTANCES) && !defined(THIN_INSTANCES)
flat varying float vSelectionId;
#else
uniform float selectionId;
#endif
uniform sampler2D styleSampler;
uniform vec2 tableSize;
uniform float discardNonmembers;
uniform float alphaCutoff;
uniform float coverageAlpha;
uniform vec3 coverageMode;
uniform float coverageDiffuse;
#ifdef SLATE_DIFFUSE
varying vec2 vUV;
uniform sampler2D diffuseSampler;
#endif
#ifdef SLATE_OPACITY
varying vec2 vOutlineOpacityUV;
uniform sampler2D opacitySampler;
uniform vec3 opacityOptions;
#endif
#ifdef SLATE_VERTEX_ALPHA
varying float vOutlineAlpha;
#endif
#include<clipPlaneFragmentDeclaration>
void main(void) {
  #include<clipPlaneFragment>
  float coverage = coverageAlpha;
  #ifdef SLATE_DIFFUSE
  float diffuseAlpha = texture2D(diffuseSampler, vUV).a;
  if (coverageMode.x > 0.5 && diffuseAlpha < alphaCutoff) discard;
  if (coverageDiffuse > 0.5) coverage *= diffuseAlpha;
  #endif
  #ifdef SLATE_OPACITY
  vec4 opacityMap = texture2D(opacitySampler, vOutlineOpacityUV);
  if (opacityOptions.y > 0.5) {
    if (opacityOptions.z > 0.5) coverage = clamp(dot(opacityMap.rgb, vec3(0.2126,0.7152,0.0722)),0.0,1.0);
    else coverage *= dot(opacityMap.rgb, vec3(0.3,0.59,0.11));
  } else coverage *= opacityMap.a;
  coverage *= opacityOptions.x;
  #endif
  #ifdef SLATE_VERTEX_ALPHA
  coverage *= vOutlineAlpha;
  #endif
  if ((coverageMode.z > 0.5 && coverage <= 0.0) || (coverageMode.y > 0.5 && coverage < alphaCutoff)) discard;
  #if defined(INSTANCES) && !defined(THIN_INSTANCES)
  float id = vSelectionId;
  #else
  float id = selectionId;
  #endif
  vec2 tableUV = (vec2(mod(id, tableSize.x), floor(id / tableSize.x)) + 0.5) / tableSize;
  if (texture2D(styleSampler, tableUV).a <= 0.0) {
    if (discardNonmembers > 0.5) discard;
    id = 0.0;
  }
  gl_FragColor = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0), 255.0) / 255.0;
}`;
  ShaderStore.ShadersStoreWGSL[`${SHARED_OUTLINE_MASK_SHADER}PixelShader`] = `
#if defined(INSTANCES) && !defined(THIN_INSTANCES)
flat varying vSelectionId: f32;
#else
uniform selectionId: f32;
#endif
var styleSamplerSampler: sampler;
var styleSampler: texture_2d<f32>;
uniform tableSize: vec2f;
uniform discardNonmembers: f32;
uniform alphaCutoff: f32;
uniform coverageAlpha: f32;
uniform coverageMode: vec3f;
uniform coverageDiffuse: f32;
#ifdef SLATE_DIFFUSE
varying vUV: vec2f;
var diffuseSamplerSampler: sampler;
var diffuseSampler: texture_2d<f32>;
#endif
#ifdef SLATE_OPACITY
varying vOutlineOpacityUV: vec2f;
var opacitySamplerSampler: sampler;
var opacitySampler: texture_2d<f32>;
uniform opacityOptions: vec3f;
#endif
#ifdef SLATE_VERTEX_ALPHA
varying vOutlineAlpha: f32;
#endif
#include<clipPlaneFragmentDeclaration>
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  #include<clipPlaneFragment>
  var coverage: f32 = uniforms.coverageAlpha;
  #ifdef SLATE_DIFFUSE
  let diffuseAlpha = textureSample(diffuseSampler, diffuseSamplerSampler, fragmentInputs.vUV).a;
  if (uniforms.coverageMode.x > 0.5 && diffuseAlpha < uniforms.alphaCutoff) { discard; }
  if (uniforms.coverageDiffuse > 0.5) { coverage *= diffuseAlpha; }
  #endif
  #ifdef SLATE_OPACITY
  let opacityMap = textureSample(opacitySampler, opacitySamplerSampler, fragmentInputs.vOutlineOpacityUV);
  if (uniforms.opacityOptions.y > 0.5) {
    if (uniforms.opacityOptions.z > 0.5) { coverage = clamp(dot(opacityMap.rgb, vec3f(0.2126,0.7152,0.0722)),0.0,1.0); }
    else { coverage *= dot(opacityMap.rgb, vec3f(0.3,0.59,0.11)); }
  } else { coverage *= opacityMap.a; }
  coverage *= uniforms.opacityOptions.x;
  #endif
  #ifdef SLATE_VERTEX_ALPHA
  coverage *= fragmentInputs.vOutlineAlpha;
  #endif
  if ((uniforms.coverageMode.z > 0.5 && coverage <= 0.0) || (uniforms.coverageMode.y > 0.5 && coverage < uniforms.alphaCutoff)) { discard; }
  #if defined(INSTANCES) && !defined(THIN_INSTANCES)
  var id: f32 = fragmentInputs.vSelectionId;
  #else
  var id: f32 = uniforms.selectionId;
  #endif
  let tableUV = (vec2f(id % uniforms.tableSize.x, floor(id / uniforms.tableSize.x)) + 0.5) / uniforms.tableSize;
  if (textureSampleLevel(styleSampler, styleSamplerSampler, tableUV, 0.0).a <= 0.0) {
    if (uniforms.discardNonmembers > 0.5) { discard; }
    id = 0.0;
  }
  fragmentOutputs.color = vec4f(id % 256.0, floor(id / 256.0) % 256.0, floor(id / 65536.0), 255.0) / 255.0;
}`;
  const groups = ["strict", "through", "selection"];
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const glslCandidates = groups.map((group, groupIndex) => `if (activeGroups[${groupIndex}] > 0.5) {
    float center = decodeId(texture2D(${group}Mask, vUV).rgb);
    float best = 1e10;
    float chosen = 1e10;
    vec4 stroke = vec4(0.0);
    for (int radius = 1; radius <= ${SHARED_OUTLINE_MAX_WIDTH}; ++radius) {
      if (float(radius) > maximumWidth + 0.75) break;
      ${offsets.map(([x, y]) => `{
        vec2 delta = vec2(${x}.0, ${y}.0) * float(radius);
        vec2 uv = vUV + delta / screenSize;
        float id = decodeId(texture2D(${group}Mask, uv).rgb);
        if (id > 0.0 && id != center) {
          vec4 style = texture2D(${group}Style, idUV(id));
          float distance = length(delta);
          bool visible = true;
          ${group === "strict" ? `float candidateDepth = texture2D(strictDepth, uv).r;
          float destinationDepth = texture2D(strictDepth, vUV).r;
          visible = reverseDepth > 0.5 ? candidateDepth >= destinationDepth : candidateDepth <= destinationDepth;` : ""}
          float score = distance / max(style.a, 0.25);
          if (visible && distance <= style.a + 0.75 && (score < best || (score == best && id < chosen))) {
            stroke = vec4(style.rgb, 1.0); best = score; chosen = id;
          }
        }
      }`).join("\n")}
    }
    if (stroke.a > 0.0) result = stroke;
  }`).join("\n");
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_COMPOSE_SHADER}PixelShader`] = `
varying vec2 vUV;
uniform vec2 screenSize;
uniform vec2 tableSize;
uniform float maximumWidth;
uniform float reverseDepth;
uniform vec3 activeGroups;
uniform sampler2D strictDepth;
${groups.map((group) => `uniform sampler2D ${group}Mask; uniform sampler2D ${group}Style;`).join("\n")}
float decodeId(vec3 value) { return dot(floor(value * 255.0 + 0.5), vec3(1.0, 256.0, 65536.0)); }
vec2 idUV(float id) { return (vec2(mod(id, tableSize.x), floor(id / tableSize.x)) + 0.5) / tableSize; }
void main(void) { vec4 result = vec4(0.0); ${glslCandidates} gl_FragColor = result; }
`;
  const wgslCandidates = groups.map((group, groupIndex) => `if (uniforms.activeGroups[${groupIndex}] > 0.5) {
    let center = decodeId(textureSampleLevel(${group}Mask, ${group}MaskSampler, fragmentInputs.vUV, 0.0).rgb);
    var best = 1e10;
    var chosen = 1e10;
    var stroke = vec4f(0.0);
    for (var radius: i32 = 1; radius <= ${SHARED_OUTLINE_MAX_WIDTH}; radius = radius + 1) {
      if (f32(radius) > uniforms.maximumWidth + 0.75) { break; }
      ${offsets.map(([x, y]) => `{
        let delta = vec2f(${x}.0, ${y}.0) * f32(radius);
        let uv = fragmentInputs.vUV + delta / uniforms.screenSize;
        let id = decodeId(textureSampleLevel(${group}Mask, ${group}MaskSampler, uv, 0.0).rgb);
        if (id > 0.0 && id != center) {
          let style = textureSampleLevel(${group}Style, ${group}StyleSampler, idUV(id), 0.0);
          let distance = length(delta);
          var visible = true;
          ${group === "strict" ? `let candidateDepth = textureSampleLevel(strictDepth, strictDepthSampler, uv, 0.0).r;
          let destinationDepth = textureSampleLevel(strictDepth, strictDepthSampler, fragmentInputs.vUV, 0.0).r;
          visible = select(candidateDepth <= destinationDepth, candidateDepth >= destinationDepth, uniforms.reverseDepth > 0.5);` : ""}
          let score = distance / max(style.a, 0.25);
          if (visible && distance <= style.a + 0.75 && (score < best || (score == best && id < chosen))) {
            stroke = vec4f(style.rgb, 1.0); best = score; chosen = id;
          }
        }
      }`).join("\n")}
    }
    if (stroke.a > 0.0) { result = stroke; }
  }`).join("\n");
  ShaderStore.ShadersStoreWGSL[`${SHARED_OUTLINE_COMPOSE_SHADER}PixelShader`] = `
varying vUV: vec2f;
uniform screenSize: vec2f;
uniform tableSize: vec2f;
uniform maximumWidth: f32;
uniform reverseDepth: f32;
uniform activeGroups: vec3f;
var strictDepthSampler: sampler; var strictDepth: texture_2d<f32>;
${groups.map((group) => `var ${group}MaskSampler: sampler; var ${group}Mask: texture_2d<f32>; var ${group}StyleSampler: sampler; var ${group}Style: texture_2d<f32>;`).join("\n")}
fn decodeId(value: vec3f) -> f32 { return dot(floor(value * 255.0 + 0.5), vec3f(1.0, 256.0, 65536.0)); }
fn idUV(id: f32) -> vec2f { return (vec2f(id % uniforms.tableSize.x, floor(id / uniforms.tableSize.x)) + 0.5) / uniforms.tableSize; }
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs { var result = vec4f(0.0); ${wgslCandidates} fragmentOutputs.color = result; }
`;
}

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

/** Keep pinned native deformation/instance code; only the owned attribute name changes. */
export function registerSharedOutlineShaders(): void {
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_MASK_SHADER}VertexShader`] =
    selectionVertexShader.shader.replaceAll("instanceSelectionId", SHARED_OUTLINE_ATTRIBUTE);
  ShaderStore.ShadersStoreWGSL[`${SHARED_OUTLINE_MASK_SHADER}VertexShader`] =
    selectionVertexShaderWGSL.shader.replaceAll("instanceSelectionId", SHARED_OUTLINE_ATTRIBUTE);
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_MASK_SHADER}PixelShader`] = `
#ifdef INSTANCES
flat varying float vSelectionId;
#else
uniform float selectionId;
#endif
uniform sampler2D styleSampler;
uniform vec2 tableSize;
uniform float discardNonmembers;
uniform float alphaCutoff;
#ifdef ALPHATEST
varying vec2 vUV;
uniform sampler2D diffuseSampler;
#endif
#include<clipPlaneFragmentDeclaration>
void main(void) {
  #include<clipPlaneFragment>
  #ifdef ALPHATEST
  if (texture2D(diffuseSampler, vUV).a < alphaCutoff) discard;
  #endif
  #ifdef INSTANCES
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
#ifdef INSTANCES
flat varying vSelectionId: f32;
#else
uniform selectionId: f32;
#endif
var styleSamplerSampler: sampler;
var styleSampler: texture_2d<f32>;
uniform tableSize: vec2f;
uniform discardNonmembers: f32;
uniform alphaCutoff: f32;
#ifdef ALPHATEST
varying vUV: vec2f;
var diffuseSamplerSampler: sampler;
var diffuseSampler: texture_2d<f32>;
#endif
#include<clipPlaneFragmentDeclaration>
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  #include<clipPlaneFragment>
  #ifdef ALPHATEST
  if (textureSample(diffuseSampler, diffuseSamplerSampler, fragmentInputs.vUV).a < uniforms.alphaCutoff) { discard; }
  #endif
  #ifdef INSTANCES
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

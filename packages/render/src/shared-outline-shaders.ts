import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { EngineStore } from "@babylonjs/core/Engines/engineStore";
import { selectionVertexShader } from "@babylonjs/core/Shaders/selection.vertex";
import "@babylonjs/core/Shaders/selection.fragment";
import "@babylonjs/core/Shaders/postprocess.vertex";
import { SHARED_OUTLINE_ATTRIBUTE, SHARED_OUTLINE_GROUPS, SHARED_OUTLINE_MAX_WIDTH } from "./shared-outline";
import { checkedShader } from "./checked-shader";
import { latticeShaderDeclarations, latticeShaderFunctions, LATTICE_WORLD_POSITION_PATTERN, latticeWorldPositionCode } from "./lattice-deformer-shader";

export const SHARED_OUTLINE_MASK_SHADER = "hapticSharedOutlineMask";
export const SHARED_OUTLINE_COMPOSE_SHADER = "hapticSharedOutlineCompose";
/** Copies the scene's depth into the strict mask's own, so its pass draws no occluder that depth holds. */
export const SHARED_OUTLINE_DEPTH_SEED_SHADER = "hapticSharedOutlineDepthSeed";

function maskVertex(source: string): string {
  const scene = EngineStore.LastCreatedScene;
  if (!scene) throw new Error("Outline shaders require a Scene.");
  source = checkedShader(source, "outline lattice stage")
    .replace("#define CUSTOM_VERTEX_DEFINITIONS", latticeShaderDeclarations() + latticeShaderFunctions(scene))
    .replace(new RegExp(LATTICE_WORLD_POSITION_PATTERN), "$1" + latticeWorldPositionCode()).value;
  const declarations = `
#ifdef VERTEXALPHA
attribute vec4 color;
#endif
#ifdef HAPTIC_VERTEX_ALPHA
varying float vOutlineAlpha;
#endif
#ifdef HAPTIC_OPACITY
uniform mat4 opacityMatrix;
varying vec2 vOutlineOpacityUV;
#endif
`;
  return declarations + source.replaceAll("instanceSelectionId", SHARED_OUTLINE_ATTRIBUTE)
    .replaceAll("#ifdef INSTANCES", "#if defined(INSTANCES) && !defined(THIN_INSTANCES)")
    .replace("#ifdef UV1\nvUV=", "#ifdef HAPTIC_DIFFUSE_UV1\nvUV=")
    .replace("#ifdef UV2\nvUV=", "#ifdef HAPTIC_DIFFUSE_UV2\nvUV=")
    .replace("#include<morphTargetsVertexGlobal>", "#ifdef VERTEXALPHA\nvec4 colorUpdated=color;\n#endif\n#include<morphTargetsVertexGlobal>")
    // World materials use zero for a missing requested UV set. Stock selection
    // instead substitutes UV2, which can invent cutout holes in the mask.
    .replace("#include<clipPlaneVertex>", `#if defined(ALPHATEST) && !defined(HAPTIC_DIFFUSE_UV1) && !defined(HAPTIC_DIFFUSE_UV2)\nvUV=vec2(diffuseMatrix*vec4(0.0,0.0,1.0,0.0));
#endif
#ifdef HAPTIC_OPACITY
#ifdef HAPTIC_OPACITY_UV1
vOutlineOpacityUV=(opacityMatrix*vec4(uvUpdated,1.0,0.0)).xy;
#elif defined(HAPTIC_OPACITY_UV2)
vOutlineOpacityUV=(opacityMatrix*vec4(uv2Updated,1.0,0.0)).xy;
#else
vOutlineOpacityUV=(opacityMatrix*vec4(vec2(0.0),1.0,0.0)).xy;
#endif
#endif
#ifdef HAPTIC_VERTEX_ALPHA
vOutlineAlpha=1.0;
#ifdef VERTEXALPHA
vOutlineAlpha*=colorUpdated.a;
#endif
#ifdef INSTANCESCOLOR
vOutlineAlpha*=instanceColor.a;
#endif
#endif
#include<clipPlaneVertex>`);
}

/** Native deformation with owned regular-instance IDs and whole-actor thin IDs. */
export function registerSharedOutlineShaders(): void {
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_DEPTH_SEED_SHADER}PixelShader`] = `
varying vec2 vUV;
uniform sampler2D sceneDepth;
void main(void) {
  gl_FragColor = vec4(0.0);
  gl_FragDepth = texture2DLodEXT(sceneDepth, vUV, 0.0).r;
}`;
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_MASK_SHADER}VertexShader`] =
    maskVertex(selectionVertexShader.shader);
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
#ifdef HAPTIC_DIFFUSE
varying vec2 vUV;
uniform sampler2D diffuseSampler;
#endif
#ifdef HAPTIC_OPACITY
varying vec2 vOutlineOpacityUV;
uniform sampler2D opacitySampler;
uniform vec3 opacityOptions;
#endif
#ifdef HAPTIC_VERTEX_ALPHA
varying float vOutlineAlpha;
#endif
#include<clipPlaneFragmentDeclaration>
void main(void) {
  #include<clipPlaneFragment>
  float coverage = coverageAlpha;
  #ifdef HAPTIC_DIFFUSE
  float diffuseAlpha = texture2D(diffuseSampler, vUV).a;
  if (coverageMode.x > 0.5 && diffuseAlpha < alphaCutoff) discard;
  if (coverageDiffuse > 0.5) coverage *= diffuseAlpha;
  #endif
  #ifdef HAPTIC_OPACITY
  vec4 opacityMap = texture2D(opacitySampler, vOutlineOpacityUV);
  if (opacityOptions.y > 0.5) {
    if (opacityOptions.z > 0.5) coverage = clamp(dot(opacityMap.rgb, vec3(0.2126,0.7152,0.0722)),0.0,1.0);
    else coverage *= dot(opacityMap.rgb, vec3(0.3,0.59,0.11));
  } else coverage *= opacityMap.a;
  coverage *= opacityOptions.x;
  #endif
  #ifdef HAPTIC_VERTEX_ALPHA
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
  const groups = SHARED_OUTLINE_GROUPS;
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  // Keep one candidate body instead of eight copies of the fade calculation.
  // These nearest, non-mipmapped buffers need no implicit texture derivatives.
  // Round group bounds up for lower-precision style sampling, retaining the
  // original view-wide cap so rounding neither removes nor adds edge pixels.
  const glslCandidates = groups.map((group, groupIndex) => `if (activeGroups[${groupIndex}] > 0.5) {
    float center = decodeId(texture2DLodEXT(${group}Mask, vUV, 0.0).rgb);
    float best = 1e10;
    float chosen = 1e10;
    vec4 stroke = vec4(0.0);${group === "strict" ? `
    // This pixel's own depth, read at its first candidate: once per pixel, and not at all where no neighbour differs.
    float destinationDepth = 0.0;
    bool destinationRead = false;` : ""}
    for (int radius = 1; radius <= ${SHARED_OUTLINE_MAX_WIDTH}; ++radius) {
      if (float(radius) > min(maximumWidth, ceil(maximumWidths[${groupIndex}])) + 0.75) break;
      for (int direction = 0; direction < 8; ++direction) {
        vec2 delta = outlineOffsets[direction] * float(radius);
        vec2 uv = vUV + delta / screenSize;
        float id = decodeId(texture2DLodEXT(${group}Mask, uv, 0.0).rgb);
        if (id > 0.0 && id != center) {
          vec4 style = texture2DLodEXT(${group}Style, idUV(id), 0.0);
          float distance = length(delta);
          float width = style.a;
          float coverage = 1.0;
          bool visible = true;
          ${group === "strict" ? `float candidateDepth = texture2DLodEXT(strictDepth, uv, 0.0).r;
          if (!destinationRead) { destinationDepth = texture2DLodEXT(strictDepth, vUV, 0.0).r; destinationRead = true; }
          visible = reverseDepth > 0.5 ? candidateDepth >= destinationDepth : candidateDepth <= destinationDepth;
          if (distanceFadeEnabled > 0.5) {
            vec4 fade = texture2DLodEXT(strictStyle, idUV(id) + vec2(0.0, 0.5), 0.0);
            if (fade.x > 0.5) {
              vec4 position = inverseProjection * vec4(uv * 2.0 - 1.0, candidateDepth * depthRange.x + depthRange.y, 1.0);
              float cameraDistance = length(position.xyz) / max(abs(position.w), 1e-8);
              width *= 1.0 - smoothstep(fade.y, fade.z, cameraDistance);
              // Preserve the authored footprint at full width. As it shrinks, the
              // outer samples lose coverage first; the first pixel survives all
              // the way to width zero, including authored subpixel widths.
              float edge = max(0.0, distance - 1.0);
              coverage = clamp((width - edge) / max(clamp(style.a - edge, 0.0, 1.0), 1e-4), 0.0, 1.0);
            }
          }` : ""}
          float score = distance / max(width, 1e-4);
          if (visible && coverage > 0.0 && distance <= style.a + 0.75 && (score < best || (score == best && id < chosen))) {
            stroke = vec4(style.rgb, coverage); best = score; chosen = id;
          }
        }
      }
    }
    if (stroke.a > 0.0) result = stroke;
  }`).join("\n");
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_COMPOSE_SHADER}PixelShader`] = `
varying vec2 vUV;
uniform vec2 screenSize;
uniform vec2 tableSize;
uniform float maximumWidth;
uniform vec3 maximumWidths;
uniform float distanceFadeEnabled;
uniform float reverseDepth;
uniform vec3 activeGroups;
uniform mat4 inverseProjection;
uniform vec2 depthRange;
uniform sampler2D strictDepth;
${groups.map((group) => `uniform sampler2D ${group}Mask; uniform sampler2D ${group}Style;`).join("\n")}
const vec2 outlineOffsets[8] = vec2[8](${offsets.map(([x, y]) => `vec2(${x}.0, ${y}.0)`).join(", ")});
float decodeId(vec3 value) { return dot(floor(value * 255.0 + 0.5), vec3(1.0, 256.0, 65536.0)); }
vec2 idUV(float id) { return (vec2(mod(id, tableSize.x), floor(id / tableSize.x)) + 0.5) / tableSize; }
void main(void) { vec4 result = vec4(0.0); ${glslCandidates} gl_FragColor = result; }
`;
}

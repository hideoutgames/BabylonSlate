import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { EngineStore } from "@babylonjs/core/Engines/engineStore";
import { selectionVertexShader } from "@babylonjs/core/Shaders/selection.vertex";
import "@babylonjs/core/Shaders/selection.fragment";
import "@babylonjs/core/Shaders/postprocess.vertex";
import { SHARED_OUTLINE_ATTRIBUTE } from "./shared-outline";
import { SHARED_OUTLINE_STROKE_INCLUDE } from "./shared-outline-stroke";
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
    .replace("#ifdef UV1\nvUV=", "#ifdef SLATE_DIFFUSE_UV1\nvUV=")
    .replace("#ifdef UV2\nvUV=", "#ifdef SLATE_DIFFUSE_UV2\nvUV=")
    .replace("#include<morphTargetsVertexGlobal>", "#ifdef VERTEXALPHA\nvec4 colorUpdated=color;\n#endif\n#include<morphTargetsVertexGlobal>")
    // World materials use zero for a missing requested UV set. Stock selection
    // instead substitutes UV2, which can invent cutout holes in the mask.
    .replace("#include<clipPlaneVertex>", `#if defined(ALPHATEST) && !defined(SLATE_DIFFUSE_UV1) && !defined(SLATE_DIFFUSE_UV2)\nvUV=vec2(diffuseMatrix*vec4(0.0,0.0,1.0,0.0));
#endif
#ifdef SLATE_OPACITY
#ifdef SLATE_OPACITY_UV1
vOutlineOpacityUV=(opacityMatrix*vec4(uvUpdated,1.0,0.0)).xy;
#elif defined(SLATE_OPACITY_UV2)
vOutlineOpacityUV=(opacityMatrix*vec4(uv2Updated,1.0,0.0)).xy;
#else
vOutlineOpacityUV=(opacityMatrix*vec4(vec2(0.0),1.0,0.0)).xy;
#endif
#endif
#ifdef SLATE_VERTEX_ALPHA
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
  // The stroke's one copy (`shared-outline-stroke.ts`), which a Display Color pass that composites it includes too.
  ShaderStore.ShadersStore[`${SHARED_OUTLINE_COMPOSE_SHADER}PixelShader`] = `
varying vec2 vUV;
#include<${SHARED_OUTLINE_STROKE_INCLUDE}>
void main(void) { gl_FragColor = ${SHARED_OUTLINE_STROKE_INCLUDE}(vUV); }
`;
}

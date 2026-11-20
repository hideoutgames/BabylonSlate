import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
import { celFunctions, CEL_UNIFORMS } from "./cel-shader";
import { HAPTIC_CLUSTERS_GLSL, HAPTIC_LIGHTS_GLSL } from "./haptic-lights";
import {
  HAPTIC_IRRADIANCE_UNIFORMS,
  HAPTIC_LIGHTING_FUNCTIONS_GLSL,
  HAPTIC_SHADOW_ATLAS,
  HAPTIC_SHADOW_ATLAS_DEPTH,
  hapticLightingGlsl,
} from "./haptic-lighting-shader";

export const DECAL_SHADER_NAME = "hapticDecal";

let registered = false;

const DECAL_VERTEX_SHADER = `
precision highp float;

attribute vec3 position;
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
attribute vec4 decalInv0;
attribute vec4 decalInv1;
attribute vec4 decalInv2;
attribute vec4 decalInv3;
attribute vec4 decalTintOpacity;
attribute vec4 decalParams;

uniform mat4 decalViewProjection;

varying mat4 vInvWorld;
varying vec3 vProjAxis;
varying vec3 vTangent;
varying vec4 vTintOpacity;
varying vec4 vDecalParams;

void main(void) {
  mat4 world = mat4(world0, world1, world2, world3);
  vInvWorld = mat4(decalInv0, decalInv1, decalInv2, decalInv3);
  vProjAxis = normalize(world1.xyz);
  vTangent = normalize(world0.xyz);
  vTintOpacity = decalTintOpacity;
  vDecalParams = decalParams;
  gl_Position = decalViewProjection * (world * vec4(position, 1.0));
}
`;

function buildDecalFragmentShader(): string {
  const lightingEval = hapticLightingGlsl(
    {
      worldPosition: "vec4(worldPos, 1.0)",
      worldNormal: "vec4(geomN, 0.0)",
      normal: "shadingN",
      cameraPosition: "cameraPosition",
      baseColor: "albedo",
      metallic: "0.0",
      specular: "0.5",
      roughness: "vDecalParams.x",
      environmentInfluence: "1.0",
    },
    {
      diffuseDirect: "dDiffuseDirect",
      specularDirect: "dSpecularDirect",
      diffuseIndirect: "dDiffuseIndirect",
      specularIndirect: "dSpecularIndirect",
    },
  );
  const envUniforms = [
    "hapticEnvironment",
    "hapticEnvironmentForm",
    "hapticEnvironmentBoxPosition",
    "hapticEnvironmentBoxSize",
    ...HAPTIC_IRRADIANCE_UNIFORMS,
  ].map((name) => `uniform vec4 ${name};`).join("\n");
  const celUniforms = CEL_UNIFORMS.map((name) => `uniform vec4 ${name};`).join("\n");

  return `
precision highp float;

#include<helperFunctions>

uniform sampler2D sceneDepth;
uniform sampler2D albedoSampler;
#ifdef DECAL_NORMAL_MAP
uniform sampler2D normalSampler;
#endif

uniform mat4 decalInvViewProjection;
uniform mat4 decalView;
uniform mat4 decalAlbedoMatrix;
#ifdef DECAL_NORMAL_MAP
uniform mat4 decalNormalMatrix;
#endif
uniform vec2 invViewport;
uniform vec2 depthRange;
uniform float reverseDepth;
uniform vec3 cameraPosition;
uniform float sceneLinear;
uniform float blendModeId;
uniform vec4 sceneFogInfo;
uniform vec4 sceneFogColor;

#ifdef DECAL_LIT
#ifndef HAPTIC_CEL
#define HAPTIC_ENVIRONMENT
#endif
${envUniforms}
uniform mat4 hapticEnvironmentMatrix;
uniform float hapticShadowReceiver;
#ifdef HAPTIC_CEL
${celUniforms}
#endif
#ifdef HAPTIC_ENVIRONMENT
uniform samplerCube hapticEnvironmentSampler;
#endif
#ifndef HAPTIC_CEL
uniform sampler2D hapticEnvironmentBrdfSampler;
#endif
uniform sampler2D hapticAreaLtcSampler;
uniform highp sampler2DArray hapticAreaEmissionSampler;
uniform highp sampler2DArrayShadow ${HAPTIC_SHADOW_ATLAS};
#ifndef HAPTIC_CEL
uniform highp sampler2DArray ${HAPTIC_SHADOW_ATLAS_DEPTH};
#endif

${HAPTIC_LIGHTS_GLSL}
${HAPTIC_CLUSTERS_GLSL}
#ifdef HAPTIC_CEL
${celFunctions()}
#endif
${HAPTIC_LIGHTING_FUNCTIONS_GLSL}
#endif

varying mat4 vInvWorld;
varying vec3 vProjAxis;
varying vec3 vTangent;
varying vec4 vTintOpacity;
varying vec4 vDecalParams;

// How much of the decal the scene's fog keeps, for a fogged scene (the caller skips it without fog: mode 0). One exit:
// D3D11's HLSL compiler (ANGLE on Windows) crashes the GPU process linking this program when the function returns early.
float decalFogKeep(vec3 viewPos) {
  float mode = sceneFogInfo.x;
  float dist = length(viewPos);
  float f = 1.0;
  if (mode < 1.5) {
    f = 1.0 / exp(dist * sceneFogInfo.w);
  } else if (mode < 2.5) {
    float k = dist * sceneFogInfo.w;
    f = 1.0 / exp(k * k);
  } else {
    f = (sceneFogInfo.z - dist) / max(sceneFogInfo.z - sceneFogInfo.y, 1e-4);
  }
  return toLinearSpace(clamp(f, 0.0, 1.0));
}

void main(void) {
  vec2 screenUV = gl_FragCoord.xy * invViewport;
  float raw = texture2D(sceneDepth, screenUV).r;
  bool isSky = reverseDepth > 0.5 ? (raw <= 0.0) : (raw >= 1.0);
  if (isSky) discard;

  vec4 clipPos = vec4(screenUV * 2.0 - 1.0, raw * depthRange.x + depthRange.y, 1.0);
  vec4 worldH = decalInvViewProjection * clipPos;
  if (abs(worldH.w) < 1e-6) discard;
  vec3 worldPos = worldH.xyz / worldH.w;

  vec3 localPos = (vInvWorld * vec4(worldPos, 1.0)).xyz;
  if (abs(localPos.x) > 0.5 || abs(localPos.y) > 0.5 || abs(localPos.z) > 0.5) discard;

  vec2 decalUV = localPos.xz + 0.5;
  // Each texture's UV transform, as Babylon's materials apply theirs (a KTX2 texture flips V there).
  vec4 tex = texture2D(albedoSampler, (decalAlbedoMatrix * vec4(decalUV, 1.0, 0.0)).xy);
  float alpha = tex.a * vTintOpacity.a;
  if (alpha <= 0.004) discard;

  vec3 dPdx = dFdx(worldPos);
  vec3 dPdy = dFdy(worldPos);
  vec3 geomN = cross(dPdx, dPdy);
  float geomLen = length(geomN);
  if (geomLen < 1e-6) discard;
  geomN /= geomLen;
  // The visible surface's outward normal faces the viewer: back along the pixel's ray, from the surface towards the
  // near plane (perspective or orthographic alike).
  vec4 nearH = decalInvViewProjection * vec4(clipPos.xy, (reverseDepth > 0.5 ? 1.0 : 0.0) * depthRange.x + depthRange.y, 1.0);
  if (dot(geomN, nearH.xyz / nearH.w - worldPos) < 0.0) geomN = -geomN;
  // Local +Y: the decal projects along -Y, onto surfaces facing back up +Y. Fade Angle is the surface normal's angle from
  // +Y, so past 90 degrees it also reaches surfaces facing away from the projector (and 180 never fades).
  vec3 projAxis = normalize(vProjAxis);

  float facing = dot(geomN, projAxis);
  float cosFade = vDecalParams.y;
  float angleWeight = cosFade <= -0.9999 ? 1.0 : smoothstep(cosFade - 0.08, min(cosFade + 0.08, 1.0), facing);
  float depthFade = 1.0 - smoothstep(0.42, 0.5, abs(localPos.y));
  alpha *= angleWeight * depthFade;
  if (alpha <= 0.004) discard;

  vec3 shadingN = geomN;
#ifdef DECAL_NORMAL_MAP
  vec3 T = vTangent - geomN * dot(vTangent, geomN);
  float tLen = length(T);
  if (tLen > 1e-5) {
    T /= tLen;
    vec3 B = normalize(cross(geomN, T));
    vec3 nTS = texture2D(normalSampler, (decalNormalMatrix * vec4(decalUV, 1.0, 0.0)).xy).xyz * 2.0 - 1.0;
    shadingN = normalize(T * nTS.x + B * nTS.y + geomN * max(nTS.z, 0.001));
  }
#endif

  vec3 albedo = toLinearSpace(tex.rgb) * toLinearSpace(vTintOpacity.rgb);
  vec3 color = albedo;

#ifdef DECAL_LIT
  vec3 dDiffuseDirect = vec3(0.0);
  vec3 dSpecularDirect = vec3(0.0);
  vec3 dDiffuseIndirect = vec3(0.0);
  vec3 dSpecularIndirect = vec3(0.0);
  ${lightingEval}
  color = dDiffuseDirect + dSpecularDirect + dDiffuseIndirect + dSpecularIndirect;
#endif

  if (sceneFogInfo.x > 0.5 && blendModeId < 0.5) {
    vec3 viewPos = (decalView * vec4(worldPos, 1.0)).xyz;
    float keep = decalFogKeep(viewPos);
    color = mix(sceneFogColor.rgb, color, keep);
  }

  if (sceneLinear < 0.5) {
    color = toGammaSpace(max(color, vec3(0.0)));
  }

  if (blendModeId > 1.5) {
    // Additive
    gl_FragColor = vec4(color * alpha, 1.0);
  } else if (blendModeId > 0.5) {
    // Multiply
    gl_FragColor = vec4(mix(vec3(1.0), color, alpha), 1.0);
  } else {
    // Alpha
    gl_FragColor = vec4(color, alpha);
  }
}
`;
}

export function registerDecalShaders(): void {
  if (registered) return;
  registered = true;
  ShaderStore.ShadersStore[`${DECAL_SHADER_NAME}VertexShader`] = DECAL_VERTEX_SHADER;
  ShaderStore.ShadersStore[`${DECAL_SHADER_NAME}FragmentShader`] = buildDecalFragmentShader();
}

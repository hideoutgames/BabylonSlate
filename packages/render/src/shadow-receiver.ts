import { checkedShader } from "./checked-shader";

/**
 * Directional PCF receiver-plane correction for Babylon 9.20. The common
 * comparison depth reaches the nearest point of the native bilinear kernel.
 * It adds no fetches, samplers or caster displacement. Automatic mode only;
 * manual and perspective/cube lights retain the native path. The normalized
 * depth ceiling scales with the actual map allocation, independently of scene
 * bounds. Near-singular derivatives retain the small caster bias alone.
 */
const ELIGIBLE =
  "defined(SLATE_SHADOW_AUTO{X}) && defined(DIRLIGHT{X}) && defined(SHADOWPCF{X}) && !defined(SHADOWCUBE{X})";

function receiverBlock(
  wgsl: boolean,
  source: string,
  target: string,
): string {
  const v2 = wgsl ? "vec2f" : "vec2";
  const v3 = wgsl ? "vec3f" : "vec3";
  const declare = (type: string, name: string, expression: string) =>
    wgsl
      ? `var ${name}: ${type} = ${expression};`
      : `${type} ${name} = ${expression};`;
  const finiteGradient = wgsl
    ? "all(abs(rpGradient) < vec2f(1e10))"
    : "all(lessThan(abs(rpGradient), vec2(1e10)))";
  const f32 = wgsl ? "f32" : "float";
  return `{
${target} = ${source};
${declare(v3, "rpClip", `${source}.xyz / ${source}.w`)}
${declare(v3, "rpUvDepth", `${v3}(rpClip.xy * 0.5 + ${v2}(0.5), rpClip.z)`)}
#ifndef IS_NDC_HALF_ZRANGE
rpUvDepth.z = rpUvDepth.z * 0.5 + 0.5;
#endif
// Orient increasing depth away from the light on either comparison path.
#ifdef USE_REVERSE_DEPTHBUFFER
rpUvDepth.z = -rpUvDepth.z;
#endif
// Derivatives always execute before validity branches and cascade selection.
${declare(v3, "rpDx", `${wgsl ? "dpdx" : "dFdx"}(rpUvDepth)`)}
${declare(v3, "rpDy", `${wgsl ? "dpdy" : "dFdy"}(rpUvDepth)`)}
${declare(f32, "rpScale", "max(max(abs(rpDx.x), abs(rpDx.y)), max(abs(rpDy.x), abs(rpDy.y)))")}
if (rpScale > 1e-20 && rpScale < 1e20) {
  rpDx /= rpScale;
  rpDy /= rpScale;
  ${declare(f32, "rpDet", "rpDx.x * rpDy.y - rpDx.y * rpDy.x")}
  // Reject singular/grazing inverse Jacobians; never manufacture a huge bias.
  if (abs(rpDet) > 1e-4 && abs(rpDet) < 4.0) {
    ${declare(v2, "rpGradient", `${v2}(rpDx.z * rpDy.y - rpDy.z * rpDx.y, rpDy.z * rpDx.x - rpDx.z * rpDy.x) / rpDet`)}
    // PCF's native shadowsInfo.y/z are actual map width and its reciprocal.
    rpGradient *= light{X}.shadowsInfo.z;
    if (${finiteGradient}) {
      ${declare(v2, "rpPhase", `fract(rpUvDepth.xy * light{X}.shadowsInfo.y - ${v2}(0.5))`)}
      ${declare(f32, "rpRadius", "2.0")}
#if defined(SHADOWLOWQUALITY{X})
      rpRadius = 0.0;
#elif defined(SHADOWMEDIUMQUALITY{X})
      rpRadius = 1.0;
#endif
      // Minimum receiver-plane depth across usual PCF bilinear texel support.
      ${declare(f32, "rpBound", `dot(max(rpGradient, ${v2}(0.0)), rpPhase + ${v2}(rpRadius)) + dot(max(-rpGradient, ${v2}(0.0)), ${v2}(1.0 + rpRadius) - rpPhase)`)}
      ${declare(f32, "rpOffset", `min(4.0 * light{X}.shadowsInfo.z, max(0.0, rpBound))`)}
#ifndef IS_NDC_HALF_ZRANGE
      rpOffset *= 2.0;
#endif
#ifdef USE_REVERSE_DEPTHBUFFER
      ${target}.z += rpOffset * ${source}.w;
#else
      ${target}.z -= rpOffset * ${source}.w;
#endif
    }
  }
}
}`;
}

/** Transform the current adapted include, retaining all its unrelated changes. */
export function withDirectionalPcfReceiverBias(
  source: string,
  wgsl: boolean,
): string {
  const target = "slatePcfPosition{X}";
  const single = `${wgsl ? "fragmentInputs." : ""}vPositionFromLight{X}`;
  const cascades = [0, 1, 2, 3]
    .map((layer) => {
      const input = wgsl
        ? `fragmentInputs.vPositionFromLight{X}_${layer}`
        : `vPositionFromLight{X}[${layer}]`;
      return `#if SHADOWCSMNUM_CASCADES{X} > ${layer}
${receiverBlock(wgsl, input, `${target}[${layer}]`)}
#endif`;
    })
    .join("\n");
  const preparation = `#if ${ELIGIBLE}
#ifdef SHADOWCSM{X}
${wgsl ? `var ${target}: array<vec4f, 4>;` : `vec4 ${target}[SHADOWCSMNUM_CASCADES{X}];`}
${cascades}
#else
${wgsl ? `var ${target}: vec4f;` : `vec4 ${target};`}
${receiverBlock(wgsl, single, target)}
#endif
#endif
`;
  return checkedShader(source, wgsl ? "directional PCF WGSL" : "directional PCF GLSL")
    .replace("#ifdef SHADOW{X}\n", `#ifdef SHADOW{X}\n${preparation}`)
    .replace(
      /(?:shadow|nextShadow)=computeShadowWith(?:CSM)?PCF[135]\([^;]+\);/g,
      (call) => {
        const originalPosition = call.includes("computeShadowWithCSM")
          ? "vPositionFromLight{X}[index{X}]"
          : single;
        const correctedPosition = call.includes("computeShadowWithCSM")
          ? `${target}[index{X}]`
          : target;
        const corrected = checkedShader(call, "receiver PCF argument").replace(
          originalPosition,
          correctedPosition,
        ).value;
        // Keep vDepthMetric unchanged: it remains the original coverage gate.
        return `#if ${ELIGIBLE}\n${corrected}\n#else\n${call}\n#endif`;
      },
      9,
    ).value;
}


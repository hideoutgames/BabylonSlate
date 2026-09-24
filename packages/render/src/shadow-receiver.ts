import { checkedShader } from "./checked-shader";

/**
 * Directional PCF receiver-plane correction for Babylon 9.20. Each native
 * bilinear tap compares against the receiver plane at its own sample position.
 * Low reconstructs its bilinear footprint with four texel-center comparisons
 * so a conservative shared depth cannot erase nearby contacts. Other qualities
 * keep native tap counts. No extra samplers or caster displacement. Automatic mode only;
 * manual and perspective/cube lights retain the native path. The correction
 * includes the current projection depth interval and actual
 * allocation through the UV/depth gradient. Valid finite plane offsets must
 * remain intact at grazing angles; clamping their magnitude causes self-shadow
 * bands even on a lone flat receiver. Native CSM depth-range clamps remain.
 * Near-singular derivatives retain the small caster bias alone.
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
${target} = ${v3}(0.0, 0.0, light{X}.shadowsInfo.y);
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
      ${target} = ${v3}(rpGradient, light{X}.shadowsInfo.y);
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
  const target = "slatePcfGradient{X}";
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
${wgsl ? `var ${target}: array<vec3f, 4>;` : `vec3 ${target}[SHADOWCSMNUM_CASCADES{X}];`}
${cascades}
#else
${wgsl ? `var ${target}: vec3f;` : `vec3 ${target};`}
${receiverBlock(wgsl, single, target)}
#endif
#endif
`;
  return checkedShader(source, wgsl ? "directional PCF WGSL" : "directional PCF GLSL")
    .replace("#ifdef SHADOW{X}\n", `#ifdef SHADOW{X}\n${preparation}`)
    .replace(
      /(?:shadow|nextShadow)=computeShadowWith(?:CSM)?PCF[135]\([^;]+\);/g,
      (call) => {
        const gradient = call.includes("computeShadowWithCSM")
          ? `${target}[index{X}]`
          : target;
        const corrected = call.replace("computeShadowWith", "slateComputeShadowWith")
          .replace(/\);$/, `,${gradient});`);
        // Keep coordinates and vDepthMetric unchanged: native coverage gates,
        // filter weights and tap positions retain their existing semantics.
        return `#if ${ELIGIBLE}\n${corrected}\n#else\n${call}\n#endif`;
      },
      9,
    ).value;
}

/** Add automatic variants; manual and local lights keep the native functions. */
export function withDirectionalPcfFunctions(source: string, wgsl: boolean): string {
  const helper = wgsl ? `
fn slatePcfDepth(tap: vec2f, origin: vec3f, plane: vec3f)->f32 {
  let phase = fract(tap * plane.z - vec2f(0.5));
  let bound = dot(max(plane.xy, vec2f(0.0)), phase) + dot(max(-plane.xy, vec2f(0.0)), vec2f(1.0) - phase);
  var offset = dot(plane.xy, (tap - origin.xy) * plane.z) - bound;
#ifdef USE_REVERSE_DEPTHBUFFER
  offset = -offset;
#endif
  return origin.z + offset;
}
fn slatePcfPointDepth(tap: vec2f, origin: vec3f, plane: vec3f)->f32 {
  var offset = dot(plane.xy, (tap - origin.xy) * plane.z);
#ifdef USE_REVERSE_DEPTHBUFFER
  offset = -offset;
#endif
  return origin.z + offset;
}
` : `
#ifdef USE_REVERSE_DEPTHBUFFER
#define SLATE_PCF_MIN_DEPTH 1.1754943508e-38
#define SLATE_PCF_MAX_DEPTH 1.0
#else
#define SLATE_PCF_MIN_DEPTH 0.0
#define SLATE_PCF_MAX_DEPTH 0.99999994
#endif
float slatePcfDepth(vec2 tap, vec3 origin, vec3 plane) {
  vec2 phase = fract(tap * plane.z - vec2(0.5));
  float bound = dot(max(plane.xy, vec2(0.0)), phase) + dot(max(-plane.xy, vec2(0.0)), vec2(1.0) - phase);
  float offset = dot(plane.xy, (tap - origin.xy) * plane.z) - bound;
#ifdef USE_REVERSE_DEPTHBUFFER
  offset = -offset;
#endif
  return origin.z + offset;
}
float slatePcfPointDepth(vec2 tap, vec3 origin, vec3 plane) {
  float offset = dot(plane.xy, (tap - origin.xy) * plane.z);
#ifdef USE_REVERSE_DEPTHBUFFER
  offset = -offset;
#endif
  return origin.z + offset;
}
`;
  let result = source;
  for (const cascaded of [false, true]) {
    for (const kernel of [1, 3, 5]) {
      const name = `computeShadowWith${cascaded ? "CSM" : ""}PCF${kernel}`;
      const start = source.indexOf(`${wgsl ? "fn" : "float"} ${name}(`);
      const bodyStart = source.indexOf("{", start);
      if (start < 0 || bodyStart < 0) throw new Error(`Missing Babylon PCF function ${name}`);
      let end = bodyStart + 1;
      let nesting = 1;
      while (end < source.length && nesting) {
        const char = source[end++];
        if (char === "{") nesting++;
        else if (char === "}") nesting--;
      }
      if (nesting) throw new Error(`Unclosed Babylon PCF function ${name}`);
      const original = source.slice(start, end);
      const depth = (uv: string, point = false) => {
        const corrected = `slatePcf${point ? "Point" : ""}Depth(${uv},uvDepth,slatePlane)`;
        // Retain native CSM depth-clamp behavior after the correction.
        return cascaded
          ? wgsl ? `clamp(${corrected},0.0,0.99999994)` : `clamp(${corrected},SLATE_PCF_MIN_DEPTH,SLATE_PCF_MAX_DEPTH)`
          : corrected;
      };
      const adapted = checkedShader(original, name)
        .replace(name, name.replace("compute", "slateCompute"))
        .replace(
          wgsl ? "frustumEdgeFalloff: f32)" : "float frustumEdgeFalloff)",
          wgsl ? "frustumEdgeFalloff: f32,slatePlane: vec3f)" : "float frustumEdgeFalloff,vec3 slatePlane)",
        );
      const samples = kernel === 1 ? 1 : kernel === 3 ? 4 : 9;
      if (kernel === 1) {
        const v2 = wgsl ? "vec2f" : "vec2";
        const declaration = (type: string, name: string, value: string) => wgsl ? `var ${name}: ${type}=${value};` : `${type} ${name}=${value};`;
        const sample = (uv: string) => wgsl
          ? `textureSampleCompareLevel(shadowTexture,shadowSampler,${uv},${cascaded ? "layer," : ""}${depth(uv, true)})`
          : cascaded ? `texture2D(shadowSampler,vec4(${uv},layer,${depth(uv, true)}))`
            : `TEXTUREFUNC(shadowSampler,vec3(${uv},${depth(uv, true)}),0.)`;
        // A hardware bilinear comparison accepts only one reference depth.
        // Preserve its four weights, but evaluate the plane at each center.
        // Clamp coordinates before the depth evaluation to match edge sampling.
        const taps = [
          [0, 0, "(1.-rpPhase.x)*(1.-rpPhase.y)"],
          [1, 0, "rpPhase.x*(1.-rpPhase.y)"],
          [0, 1, "(1.-rpPhase.x)*rpPhase.y"],
          [1, 1, "rpPhase.x*rpPhase.y"],
        ].map(([x, y, weight], index) => {
          const uv = `rpTap${index}`;
          return `${declaration(v2, uv, `(clamp(rpBase+${v2}(${x}.,${y}.),${v2}(0.),${v2}(slatePlane.z-1.))+${v2}(0.5))/slatePlane.z`)}shadow+=${weight}*${sample(uv)};`;
        }).join("\n");
        adapted.replace(
          wgsl ? /var shadow: f32=textureSampleCompare(?:Level)?\([^;]+\);/ : /float shadow=(?:TEXTUREFUNC|texture2D)\([^;]+\);/,
          `${declaration(v2, "rpTexel", `uvDepth.xy*slatePlane.z-${v2}(0.5)`)}
${declaration(v2, "rpPhase", "fract(rpTexel)")}
${declaration(v2, "rpBase", "floor(rpTexel)")}
${declaration(wgsl ? "f32" : "float", "shadow", "0.")}
${taps}`,
        );
      } else if (wgsl) {
        const uvPattern = kernel === 1 ? "uvDepth\\.xy" : "base_uv\\.xy\\+ vec2f\\(u\\[(\\d)\\],v\\[(\\d)\\]\\)";
        adapted.replace(
          new RegExp(`(${uvPattern}),${cascaded ? "layer," : ""}uvDepth\\.z`, "g"),
          (_match, uv) => `${uv},${cascaded ? "layer," : ""}${depth(uv)}`,
          samples,
        );
      } else {
        adapted.replace(
          /base_uv\.xy\+vec2\(u\[(\d)\],v\[(\d)\]\),(layer,)?uvDepth\.z/g,
          (_match, u, v, layer) => {
            const uv = `base_uv.xy+vec2(u[${u}],v[${v}])`;
            return `${uv},${layer ?? ""}${depth(uv)}`;
          },
          samples,
        );
      }
      result = checkedShader(result, `add ${name} automatic variant`).replace(
        original,
        `${original}\n${wgsl ? "" : "#define inline\n"}${adapted.value}\n`,
      ).value;
    }
  }
  return helper + result;
}

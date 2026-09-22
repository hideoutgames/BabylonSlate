/**
 * Test-only receiver-plane experiment; never installed by production rendering.
 * Use a fresh dedicated engine/scene per installation. Install before any
 * material compilation, dispose that engine, then restore the include stores.
 * Existing compiled effects cannot be rolled back by restoring source text.
 */
import { ShaderStore } from "@babylonjs/core";
import { checkedShader } from "../../../../packages/render/src/checked-shader";

type Options = {
  /** One is the full common-reference bound for the usual bilinear support. */
  strength: number;
  /** Explicit normalized comparison-depth ceiling; not a scene-size policy. */
  cap: number;
};

const ELIGIBLE =
  "defined(DIRLIGHT{X}) && defined(SHADOWPCF{X}) && !defined(SHADOWCUBE{X})";
let installed = false;

function receiverBlock(
  wgsl: boolean,
  source: string,
  target: string,
  options: Options,
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
      ${declare(f32, "rpOffset", `min(${options.cap.toExponential()}, ${options.strength.toExponential()} * max(0.0, rpBound))`)}
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
export function withReceiverPlaneProbe(
  source: string,
  wgsl: boolean,
  options: Options,
): string {
  const target = "slateProbePcfPosition{X}";
  const single = `${wgsl ? "fragmentInputs." : ""}vPositionFromLight{X}`;
  const cascades = [0, 1, 2, 3]
    .map((layer) => {
      const input = wgsl
        ? `fragmentInputs.vPositionFromLight{X}_${layer}`
        : `vPositionFromLight{X}[${layer}]`;
      return `#if SHADOWCSMNUM_CASCADES{X} > ${layer}
${receiverBlock(wgsl, input, `${target}[${layer}]`, options)}
#endif`;
    })
    .join("\n");
  const preparation = `#if ${ELIGIBLE}
#ifdef SHADOWCSM{X}
${wgsl ? `var ${target}: array<vec4f, 4>;` : `vec4 ${target}[SHADOWCSMNUM_CASCADES{X}];`}
${cascades}
#else
${wgsl ? `var ${target}: vec4f;` : `vec4 ${target};`}
${receiverBlock(wgsl, single, target, options)}
#endif
#endif
`;
  return checkedShader(source, wgsl ? "receiver probe WGSL" : "receiver probe GLSL")
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

/**
 * Explicit diagnostic override: no automatic-mode contract is implied.
 * All directional PCF receivers in this isolated engine use the correction.
 * Authoring values, caster shaders and native PCF functions remain unchanged.
 */
export function installReceiverPlaneProbe(options: Options) {
  if (installed) throw new Error("A receiver-plane probe is already installed");
  if (
    !Number.isFinite(options.strength) ||
    options.strength <= 0 ||
    options.strength > 1 ||
    !Number.isFinite(options.cap) ||
    options.cap <= 0 ||
    options.cap > 1
  )
    throw new Error("Invalid explicit receiver-plane diagnostic settings");
  // Transform all four first, so a pinned-source mismatch changes no store.
  const patches = [false, true].flatMap((wgsl) => {
    const store = ShaderStore.GetIncludesShadersStore(wgsl ? 1 : 0);
    return ["lightFragment", "slateCelLightFragment"].map((name) => {
      const original = store[name];
      if (!original) throw new Error(`Missing initialized shader include: ${name}`);
      return {
        store,
        name,
        original,
        patched: withReceiverPlaneProbe(original, wgsl, options),
      };
    });
  });
  for (const patch of patches) patch.store[patch.name] = patch.patched;
  installed = true;
  let restored = false;
  return {
    get evidence() {
      return {
        ...options,
        mode: "manual-authored-diagnostic",
        label: "test-only directional PCF receiver-plane common-reference correction",
        nativeComparisonFetchCountChanged: false,
        normalOrCasterGeometryChanged: false,
        jacobianThreshold: 1e-4,
        restored,
      };
    },
    dispose() {
      if (restored) return;
      if (patches.some((patch) => patch.store[patch.name] !== patch.patched))
        throw new Error("Another shader edit replaced the receiver probe include");
      for (const patch of patches) patch.store[patch.name] = patch.original;
      installed = false;
      restored = true;
    },
  };
}

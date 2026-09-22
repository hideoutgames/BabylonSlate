/**
 * Test-only per-texel receiver-plane experiment. Four explicit comparisons
 * replace each native bilinear comparison; A16 cost is unqualified.
 * Install before compilation on a fresh dedicated engine, dispose that engine,
 * then dispose this probe. Restoring source cannot roll back cached effects.
 */
import { ShaderStore } from "@babylonjs/core";
import "@babylonjs/core/Shaders/ShadersInclude/shadowsFragmentFunctions";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowsFragmentFunctions";
import { checkedShader } from "../../../../packages/render/src/checked-shader";

type Options = {
  /** Maximum absolute correction at one texel, in normalized hardware depth. */
  cap: number;
};

const ELIGIBLE =
  "defined(DIRLIGHT{X}) && defined(SHADOWPCF{X}) && !defined(SHADOWCUBE{X})";
let installed = false;

function declaration(wgsl: boolean, type: string, name: string, value: string) {
  return wgsl
    ? `var ${name}: ${type} = ${value};`
    : `${type} ${name} = ${value};`;
}

function gradientBlock(wgsl: boolean, source: string, target: string): string {
  const v2 = wgsl ? "vec2f" : "vec2";
  const v3 = wgsl ? "vec3f" : "vec3";
  const scalar = wgsl ? "f32" : "float";
  const decl = (type: string, name: string, value: string) =>
    declaration(wgsl, type, name, value);
  return `{
${target} = ${v2}(0.0);
${decl(v3, "rtClip", `${source}.xyz / ${source}.w`)}
${decl(v3, "rtUvDepth", `${v3}(rtClip.xy * 0.5 + ${v2}(0.5), rtClip.z)`)}
#ifndef IS_NDC_HALF_ZRANGE
rtUvDepth.z = rtUvDepth.z * 0.5 + 0.5;
#endif
// Raw hardware-depth gradient: reverse comparison needs no extra sign flip.
${decl(v3, "rtDx", `${wgsl ? "dpdx" : "dFdx"}(rtUvDepth)`)}
${decl(v3, "rtDy", `${wgsl ? "dpdy" : "dFdy"}(rtUvDepth)`)}
${decl(scalar, "rtScale", "max(max(abs(rtDx.x), abs(rtDx.y)), max(abs(rtDy.x), abs(rtDy.y)))")}
if (rtScale > 1e-20 && rtScale < 1e20) {
  rtDx /= rtScale;
  rtDy /= rtScale;
  ${decl(scalar, "rtDet", "rtDx.x * rtDy.y - rtDx.y * rtDy.x")}
  if (abs(rtDet) > 1e-4 && abs(rtDet) < 4.0) {
    ${decl(v2, "rtGradient", `${v2}(rtDx.z * rtDy.y - rtDy.z * rtDx.y, rtDy.z * rtDx.x - rtDx.z * rtDy.x) / rtDet`)}
    if (${wgsl ? "all(abs(rtGradient) < vec2f(1e10))" : "all(lessThan(abs(rtGradient), vec2(1e10)))"}) {
      ${target} = rtGradient;
    }
  }
}
}`;
}

function gradientPreparation(wgsl: boolean): string {
  const target = "slateProbeTexelGradient{X}";
  const single = `${wgsl ? "fragmentInputs." : ""}vPositionFromLight{X}`;
  const cascades = [0, 1, 2, 3].map((layer) => {
    const source = wgsl
      ? `fragmentInputs.vPositionFromLight{X}_${layer}`
      : `vPositionFromLight{X}[${layer}]`;
    return `#if SHADOWCSMNUM_CASCADES{X} > ${layer}
${gradientBlock(wgsl, source, `${target}[${layer}]`)}
#endif`;
  }).join("\n");
  return `#if ${ELIGIBLE}
#ifdef SHADOWCSM{X}
${wgsl ? `var ${target}: array<vec2f, 4>;` : `vec2 ${target}[SHADOWCSMNUM_CASCADES{X}];`}
${cascades}
#else
${wgsl ? `var ${target}: vec2f;` : `vec2 ${target};`}
${gradientBlock(wgsl, single, target)}
#endif
#endif
`;
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "(") depth++;
    if (source[index] === ")" && --depth === 0) return index;
  }
  throw new Error("Unclosed native shader call in texel probe");
}

function nativeFunction(source: string, name: string, wgsl: boolean): string {
  const start = source.indexOf(`${wgsl ? "fn" : "float"} ${name}(`);
  if (start < 0) throw new Error(`Missing native PCF function: ${name}`);
  const body = source.indexOf("{", matchingParen(source, source.indexOf("(", start)));
  let depth = 0;
  for (let index = body; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0)
      return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed native PCF function: ${name}`);
}

/** Parse balanced call arguments so nested native vector constructors survive. */
function mapCalls(
  source: string,
  name: string,
  expected: number,
  map: (argumentsText: string) => string,
): string {
  let result = "";
  let cursor = 0;
  let count = 0;
  for (;;) {
    const start = source.indexOf(`${name}(`, cursor);
    if (start < 0) break;
    const open = start + name.length;
    const close = matchingParen(source, open);
    result += source.slice(cursor, start) + map(source.slice(open + 1, close));
    cursor = close + 1;
    count++;
  }
  if (count !== expected)
    throw new Error(`Texel probe expected ${expected} ${name} calls, found ${count}`);
  return result + source.slice(cursor);
}

function bilinearHelper(wgsl: boolean, csm: boolean, cap: number): string {
  const name = `slateProbeBilinear${csm ? "CSM" : "2D"}`;
  const v2 = wgsl ? "vec2f" : "vec2";
  const scalar = wgsl ? "f32" : "float";
  const decl = (type: string, identifier: string, value: string) =>
    declaration(wgsl, type, identifier, value);
  const header = wgsl
    ? `fn ${name}(shadowTexture: ${csm ? "texture_depth_2d_array" : "texture_depth_2d"}, shadowSampler: sampler_comparison, sampleUv: vec2f, ${csm ? "layer: i32, " : ""}referenceDepth: f32, receiverUv: vec2f, receiverGradient: vec2f, mapSize: f32) -> f32`
    : `float ${name}(highp ${csm ? "sampler2DArrayShadow" : "sampler2DShadow"} shadowSampler, ${csm ? "vec4" : "vec3"} sampleCoordinate, vec2 receiverUv, vec2 receiverGradient, float mapSize)`;
  const unpack = wgsl ? "" : `vec2 sampleUv=sampleCoordinate.xy;
float referenceDepth=sampleCoordinate.${csm ? "w" : "z"};`;
  const comparisons = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => {
    const suffix = `${x}${y}`;
    const center = `center${suffix}`;
    const depth = `depth${suffix}`;
    const fetch = wgsl
      ? `textureSampleCompareLevel(shadowTexture, shadowSampler, ${center}, ${csm ? "layer, " : ""}${depth})`
      : csm
        ? `texture2D(shadowSampler, vec4(${center}, sampleCoordinate.z, ${depth}))`
        : `TEXTUREFUNC(shadowSampler, vec3(${center}, ${depth}), 0.)`;
    return `${decl(v2, center, `(clamp(base + ${v2}(${x}.0, ${y}.0), ${v2}(0.0), ${v2}(mapSize - 1.0)) + ${v2}(0.5)) / mapSize`)}
${decl(scalar, depth, `referenceDepth + clamp(dot(receiverGradient, ${center} - receiverUv), -${cap.toExponential()}, ${cap.toExponential()})`)}
${decl(scalar, `sample${suffix}`, fetch)}`;
  }).join("\n");
  return `${header} {
${unpack}
${decl(v2, "texel", `sampleUv * mapSize - ${v2}(0.5)`)}
${decl(v2, "base", "floor(texel)")}
${decl(v2, "phase", "fract(texel)")}
${comparisons}
return mix(mix(sample00, sample10, phase.x), mix(sample01, sample11, phase.x), phase.y);
}`;
}

/** Clone only six native functions; their weights, taps and coverage stay intact. */
export function receiverTexelFunctions(
  source: string,
  wgsl: boolean,
  options: Options,
): string {
  const clones = [false, true].flatMap((csm) => [1, 3, 5].map((quality) => {
    const name = `computeShadowWith${csm ? "CSM" : ""}PCF${quality}`;
    const unique = `slateProbeTexel${csm ? "CSM" : ""}PCF${quality}`;
    let clone = nativeFunction(source, name, wgsl);
    const endParameters = matchingParen(clone, clone.indexOf("("));
    const parameters = wgsl
      ? ", receiverGradient: vec2f, receiverMapSize: f32"
      : ", vec2 receiverGradient, float receiverMapSize";
    clone = clone.slice(0, endParameters) + parameters + clone.slice(endParameters);
    clone = checkedShader(clone, "unique texel probe function").replace(name, unique).value;
    const calls = quality === 1 ? 1 : quality === 3 ? 4 : 9;
    const helper = `slateProbeBilinear${csm ? "CSM" : "2D"}`;
    const fetch = wgsl
      ? csm ? "textureSampleCompare" : "textureSampleCompareLevel"
      : csm ? "texture2D" : "TEXTUREFUNC";
    return mapCalls(clone, fetch, calls, (argumentsText) => {
      // GLSL TEXTUREFUNC's explicit LOD0 is implicit in the unique helper.
      const args = !wgsl && !csm
        ? checkedShader(argumentsText, "native PCF LOD").replace(/,0\.$/, "").value
        : argumentsText;
      return `${helper}(${args}, uvDepth.xy, receiverGradient, receiverMapSize)`;
    });
  }));
  return `
#if defined(SHADOWS) && (defined(WEBGL2) || defined(WEBGPU) || defined(NATIVE))
${bilinearHelper(wgsl, false, options.cap)}
${bilinearHelper(wgsl, true, options.cap)}
${clones.join("\n")}
#endif
`;
}

export function withReceiverTexelProbe(source: string, wgsl: boolean): string {
  return checkedShader(source, "receiver texel call sites")
    .replace("#ifdef SHADOW{X}\n", `#ifdef SHADOW{X}\n${gradientPreparation(wgsl)}`)
    .replace(
      /(?:shadow|nextShadow)=computeShadowWith(?:CSM)?PCF[135]\([^;]+\);/g,
      (call) => {
        const gradient = `slateProbeTexelGradient{X}${call.includes("computeShadowWithCSM") ? "[index{X}]" : ""}`;
        const corrected = call.replace("computeShadowWith", "slateProbeTexel").slice(0, -2)
          + `,${gradient},light{X}.shadowsInfo.y);`;
        return `#if ${ELIGIBLE}\n${corrected}\n#else\n${call}\n#endif`;
      },
      9,
    ).value;
}

/** Explicit manual-authored diagnostic, mutually exclusive with other probes. */
export function installReceiverTexelProbe(options: Options) {
  if (installed) throw new Error("A receiver texel probe is already installed");
  if (!Number.isFinite(options.cap) || options.cap <= 0 || options.cap > 1)
    throw new Error("Invalid individual receiver-depth correction ceiling");
  const patches = [false, true].flatMap((wgsl) => {
    const store = ShaderStore.GetIncludesShadersStore(wgsl ? 1 : 0);
    return ["shadowsFragmentFunctions", "lightFragment", "slateCelLightFragment"].map((name) => {
      const original = store[name];
      if (!original) throw new Error(`Missing initialized shader include: ${name}`);
      if (original.includes("slateProbePcfPosition") || original.includes("slateProbeTexel"))
        throw new Error("Receiver probes cannot be composed in one shader store");
      const patched = name === "shadowsFragmentFunctions"
        ? original + receiverTexelFunctions(original, wgsl, options)
        : withReceiverTexelProbe(original, wgsl);
      return { store, name, original, patched };
    });
  });
  for (const patch of patches) patch.store[patch.name] = patch.patched;
  installed = true;
  let restored = false;
  return {
    get evidence() {
      return {
        mode: "manual-authored-diagnostic",
        label: "test-only per-texel receiver-plane PCF comparisons",
        individualNormalizedOffsetCap: options.cap,
        nativeComparisonFetches: { low: 1, medium: 4, high: 9 },
        probeComparisonFetches: { low: 4, medium: 16, high: 36 },
        nativeTexelSupportAndWeightsPreserved: true,
        mapPassAndSamplerBindingsChanged: false,
        a16PerformanceQualified: false,
        normalOrCasterGeometryChanged: false,
        jacobianThreshold: 1e-4,
        restored,
      };
    },
    dispose() {
      if (restored) return;
      if (patches.some((patch) => patch.store[patch.name] !== patch.patched))
        throw new Error("Another shader edit replaced the receiver texel probe");
      for (const patch of patches) patch.store[patch.name] = patch.original;
      restored = true;
      installed = false;
    },
  };
}

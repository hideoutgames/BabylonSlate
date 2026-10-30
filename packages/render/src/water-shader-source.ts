/**
 * Assembled water shader source per language: the Water Waves node's sources and the Water Cut block's blend cull.
 * `toWgsl` translates the GLSL-shaped chunks.
 */
import { ShaderLanguage } from "@babylonjs/core";
import { WATER_FFT_CASCADES_MAX, WATER_FOAM_WEIGHTS } from "@haptic/core";
import {
  fftHelpers, fftTurnIn, fftTurnOut, fftTurnTensor, FOAM_FAR_PATCHES, ifFft, SHADING_SLOPE_CAP, spectrumHelpers, spectrumNormalSource,
  spectrumVertexSource, subsurfaceSource,
} from "./water-shader-chunks";
import {
  EDGE_FOAM_CALM, f, FFT_CASCADE_UNIFORMS, FFT_UNIFORMS, SPECTRUM_FOAM_SCALE, WATER_BLEND_DEFINE, WATER_GPU_WAVES_DEFINE,
} from "./water-shader-defines";

/**
 * Vertex stage of `SLATE_WATER_GPU_WAVES`, at CUSTOM_VERTEX_UPDATE_WORLDPOS: the spectrum's displacement
 * (`spectrumVertexSource`) at this vertex's world rest point. The rest grid carries its mesh spacing in
 * `slateWaterData.x` (the spectrum's mip) and its bank distance in `.y` (the finite-body fade of the horizontal offset).
 * Writes the displaced world position (the clip position, fog, shadows and clip planes follow it) and leaves the height
 * and offset for the varyings in `swvH` / `swvD`, so the fragment finds its rest point and contacts see the rendered
 * height. `slateWaterGridOffset` (xyz) is the world-space translation of the rest grid since its positions were uploaded
 * (Global Water's recentre, `waterGridOffset`): it is added before the rest point is taken, so the spectrum and bank terms
 * all see the translated grid. GLSL-shaped: `A.` attributes and `U.` uniforms are bound per language, then `toWgsl`
 * translates it. It also leaves `swvNormal` (`spectrumNormalSource`); `distance` is the eye-distance expression the
 * spectrum's LOD reads.
 */
function vertexWaveSource(distance: string): string {
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
float swvSpacing = A.slateWaterData.x;
worldPos = vec4(worldPos.xyz + U.slateWaterGridOffset.xyz, worldPos.w);
vec2 swvRest = worldPos.xz;
float swvH = 0.0;
vec2 swvD = vec2(0.0);${spectrumVertexSource(distance, true)}
float swvFade = U.slateWaterSwellInfo.x;
#ifdef ${WATER_BLEND_DEFINE}
swvFade = swvFade * A.slateWaterBlend.y;
#endif
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
float swvGain = mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));${spectrumNormalSource()}
#ifdef ${WATER_BLEND_DEFINE}
swvH = swvH * A.slateWaterBlend.x;
swvD = swvD * A.slateWaterBlend.y;
#endif
swvD = swvD * swvGain;
worldPos = vec4(worldPos.xyz + vec3(swvD.x, swvH, swvD.y), worldPos.w);
#endif
`;
}

/**
 * Blending surfaces on the GPU path cull vertices this many of their own grid spacings, plus `BLEND_CULL_MARGIN` metres,
 * inside water they never draw (`waterBlendCullSource`). A triangle's other vertices are at most √2 spacings away, and both
 * the ownership margin and the bank distance change by about a metre per metre (the margin's fit is approximate, hence
 * the slack), so they lie in that water too.
 */
const BLEND_CULL_CELLS = 2;
const BLEND_CULL_MARGIN = 1;
const BLEND_CULL = `if (min(A.slateWaterData.y, A.slateWaterBlend.z) < -(${f(BLEND_CULL_CELLS)} * A.slateWaterData.x + ${f(BLEND_CULL_MARGIN)})) {
  SW_CLIP_POSITION.z = 2.0 * SW_CLIP_POSITION.w;
}`;

/**
 * The blend cull for the Water Cut block's vertex program, which the graph's Water Waves node
 * displaces (GPU waves only: there `slateWaterData.x` is the grid spacing).
 */
export function waterBlendCullSource(wgsl: boolean): string {
  return `#if defined(${WATER_GPU_WAVES_DEFINE}) && defined(${WATER_BLEND_DEFINE})\n${bindVertexSource(BLEND_CULL, wgsl)
    .replace(/\bSW_CLIP_POSITION\b/g, wgsl ? "vertexOutputs.position" : "gl_Position")}\n#endif\n`;
}

/** Binds the GLSL-shaped `A.` / `U.` prefixes for one language. */
function bindVertexSource(code: string, wgsl: boolean): string {
  return code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bA\./g, wgsl ? "vertexInputs." : "");
}

/**
 * Uniforms the vertex displacement reads (`bindWaterVertexUniforms` sets them, with `WATER_FFT_SAMPLER`): the bank fade
 * (`slateWaterSwellInfo.x`), the grid offset and the spectrum's.
 */
export const WATER_VERTEX_WAVE_UNIFORMS: readonly string[] = ["slateWaterSwellInfo", "slateWaterGridOffset", ...FFT_UNIFORMS];
/**
 * The surface's water clock in seconds (x) and its foam drift in metres per second (yz, `waterFoamDrift`), for a Custom
 * Material's Water Waves and Water Foam nodes (`WaterVertexWaves.bind`).
 */
export const WATER_CLOCK_UNIFORM = "slateWaterClock";
const blockWaveSources = new Map<ShaderLanguage, string>();
/**
 * The Water Waves node's vertex code for one language: `vertexWaveSource`, bound and translated, its eye distance from `slateWaterEye` (the camera's world position relative to the rest positions). It reads
 * and writes a `worldPos` vec4 (rest point in, displaced point out) and leaves `swvH` (height), `swvD` (horizontal offset)
 * and `swvNormal`, under `SLATE_WATER_GPU_WAVES`; it reads `slateWaterData` and `slateWaterBaseNormal`, and under
 * `SLATE_WATER_BLEND` `slateWaterBlend`, as attributes. Built once.
 */
export function waterWaveBlockSource(language: ShaderLanguage): string {
  let source = blockWaveSources.get(language);
  if (!source) {
    const wgsl = language === ShaderLanguage.WGSL, code = vertexWaveSource("length(worldPos.xyz - U.slateWaterEye.xyz)");
    blockWaveSources.set(language, source = stripShaderComments(bindVertexSource(wgsl ? toWgsl(code) : code, wgsl)));
  }
  return source;
}

/** The Water Waves node's eye position uniform (`waterWaveBlockSource`): the camera relative to the rest positions. */
export const WATER_EYE_UNIFORM = "slateWaterEye";
/** The Water Waves node's foam terms: (Crest Foam, Foam Amount, the foam threshold `waterFoamThresholdOf`, 0). */
export const WATER_NODE_FOAM_UNIFORM = "slateWaterNodeFoam";
/** The Water Waves node's light: (direction toward the sun, Subsurface). */
export const WATER_NODE_SUN_UNIFORM = "slateWaterNodeWaveSun";
/** Varying the Water Waves node's vertex stage hands its fragment stage: (bank gain × offset share, height share). */
export const WATER_NODE_VARYING = "vSlateWaterWaves";

/**
 * The Water Waves node's vertex code that fills `WATER_NODE_VARYING` (`out`, the bound varying) from the mesh's bank
 * distance and blend data, as `vertexWaveSource` derives its bank gain and shares. GLSL-shaped with `A.` and `U.`.
 */
function nodeVaryingSource(out: string): string {
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
{
float swvFade = U.slateWaterSwellInfo.x;
float swvHs = 1.0;
float swvDs = 1.0;
#ifdef ${WATER_BLEND_DEFINE}
swvFade = swvFade * A.slateWaterBlend.y;
swvHs = A.slateWaterBlend.x;
swvDs = A.slateWaterBlend.y;
#endif
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
float swvGain = mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));
${out} = vec2(swvGain * swvDs, swvHs);
}
#endif
`;
}

/**
 * The Water Waves node's fragment code: the spectrum at this pixel's rest point (`rest`, the interpolated undisplaced
 * world position plus the grid offset), every cascade through its mips: the displaced surface's normal over the mesh's base normal (`base`), the height, and
 * FFT-Ocean's crest foam from the persistent turbulence with the asset's Crest Foam and Foam Amount, and the subsurface
 * light (`subsurfaceSource`). Writes `swnNormal`, `swnHeight`, `swnFoam`, `swnSubsurface` and
 * `swnEdgeTurbulence` (the turbulence past the crest threshold, which edge foam reads: `edgeFoamHelpers`).
 * GLSL-shaped with `U.`; `varying` is the bound `WATER_NODE_VARYING`.
 */
function nodeFragmentSource(rest: string, base: string, varying: string): string {
  const cascades = Array.from({ length: WATER_FFT_CASCADES_MAX }, (_, c) => {
    const code = `
vec4 swnSc${c} = U.${FFT_CASCADE_UNIFORMS[c]};
vec2 swnSu${c} = ${fftTurnIn(c, "swnRest")} * swnSc${c}.x + swnSc${c}.yz;
vec4 swnSa${c} = swSpecTap(swnSu${c}, ${f(2 * c)});
vec4 swnSb${c} = swSpecTap(swnSu${c}, ${f(2 * c + 1)});
float swnSt${c} = swFoamTap(swnSu${c}, ${f(c)}).r;
float swnSw${c} = ${c === 0 ? "1.0" : `clamp(swnSp.w / max(swnSc${c}.x * swnDist, 0.000001), 0.0, 1.0)`};
swnGrad += ${fftTurnOut(c, `swnSb${c}.xy`)} * swnSw${c};
swnJ += ${fftTurnTensor(c, `vec3(swnSb${c}.z, swnSa${c}.w, swnSb${c}.w)`)} * swnSw${c};
swnH += swnSa${c}.y * swnSw${c};${c === 0 ? `
swnLarge = swnSa0.y;` : `
swnSmall += swnSa${c}.y * swnSw${c};`}
swnFoamSum += ${f(WATER_FOAM_WEIGHTS[c]!)} * (1.0 - swnSt${c}) * swnSw${c} * swnTurbScale;`;
    return c === 0 ? code : ifFft(code, c + 1);
  }).join("");
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
{
vec3 swnRestW = ${rest}.xyz + U.slateWaterGridOffset.xyz;
vec2 swnRest = swnRestW.xz;
float swnDist = max(length(swnRestW - U.${WATER_EYE_UNIFORM}.xyz), 0.001);
vec4 swnSp = U.slateWaterFft;
vec2 swnShares = ${varying};
float swnTurbScale = swnSp.x * swnShares.x;
vec2 swnGrad = vec2(0.0);
vec3 swnJ = vec3(0.0);
float swnH = 0.0;
float swnLarge = 0.0;
float swnSmall = 0.0;
float swnFoamSum = 0.0;${cascades}
swnGrad = swnGrad * (swnSp.x * swnShares.y);
swnJ = swnJ * (swnSp.x * swnSp.y * swnShares.x);
float swnJxx = 1.0 + swnJ.x;
float swnJxz = swnJ.y;
float swnJzz = 1.0 + swnJ.z;
vec2 swnSlope = vec2(swnJzz * swnGrad.x - swnJxz * swnGrad.y, swnJxx * swnGrad.y - swnJxz * swnGrad.x) / max(swnJxx * swnJzz - swnJxz * swnJxz, 0.35);
swnSlope = swnSlope / max(1.0, length(swnSlope) / ${f(SHADING_SLOPE_CAP)});
vec3 swnBase = ${base};
swnNormal = normalize(vec3(swnBase.x / max(swnBase.y, 0.001) - swnSlope.x, 1.0, swnBase.z / max(swnBase.y, 0.001) - swnSlope.y));
swnHeight = swnH * swnSp.x * swnShares.y;
vec4 swnTerms = U.${WATER_NODE_FOAM_UNIFORM};
float swnCrestPast = swnFoamSum * swnTerms.w - swnTerms.z;
float swnPatchFar = 1.0 - smoothstep(${f(FOAM_FAR_PATCHES[0])}, ${f(FOAM_FAR_PATCHES[1])}, swnDist * swnSc0.x);
swnFoam = clamp(swnCrestPast * ${f(SPECTRUM_FOAM_SCALE)}, 0.0, 1.0) * clamp(swnTerms.y * 1.6, 0.0, 1.0) * step(0.000001, swnTerms.x) * swnPatchFar;
${subsurfaceSource(`U.${WATER_NODE_SUN_UNIFORM}.xyz`, `normalize(U.${WATER_EYE_UNIFORM}.xyz - swnRestW - vec3(0.0, swnHeight, 0.0))`, "swnNormal",
    "(0.2 * swnLarge + swnSmall) * swnSp.x * swnShares.y", `U.${WATER_NODE_SUN_UNIFORM}.w`, "swnSp.x", "swnSss")}
swnSubsurface = swnSss;
swnEdgeTurbulence = max(swnCrestPast, ${f(EDGE_FOAM_CALM)});
}
#endif
`;
}

/** Binds the GLSL-shaped `U.` and `IN.` prefixes of fragment code for one language. */
const bindFragmentSource = (code: string, wgsl: boolean) => code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bIN\./g, wgsl ? "fragmentInputs." : "");

/** The Water Waves node's per-stage sources for one language (`WaterWavesBlock`), built once each. */
export interface WaterWaveNodeSources {
  /** Taps of each stage, under `SLATE_WATER_GPU_WAVES` (the block declares the samplers). */
  vertexHelpers: string;
  fragmentHelpers: string;
  /** The vertex code that fills the node's varying, given its bound name. */
  varying(out: string): string;
  /** The fragment code, given the rest position, base normal and varying expressions (already bound). */
  fragment(rest: string, base: string, varying: string): string;
}
const nodeSources = new Map<ShaderLanguage, WaterWaveNodeSources>();
export function waterWaveNodeSources(language: ShaderLanguage): WaterWaveNodeSources {
  let sources = nodeSources.get(language);
  if (!sources) {
    const wgsl = language === ShaderLanguage.WGSL;
    const guard = (code: string) => `#ifdef ${WATER_GPU_WAVES_DEFINE}\n${code}\n#endif\n`;
    const vertexBind = (code: string) => stripShaderComments(bindVertexSource(wgsl ? toWgsl(code) : code, wgsl));
    const fragmentBind = (code: string) => stripShaderComments(bindFragmentSource(wgsl ? toWgsl(code) : code, wgsl));
    sources = {
      // The block declares the samplers itself, once per stage.
      vertexHelpers: guard(fftHelpers(wgsl, false)),
      fragmentHelpers: guard(fftHelpers(wgsl, false) + spectrumHelpers(wgsl, false)),
      varying: (out) => vertexBind(nodeVaryingSource(out)),
      fragment: (rest, base, varying) => fragmentBind(nodeFragmentSource(rest, base, varying)),
    };
    nodeSources.set(language, sources);
  }
  return sources;
}

/** Translate the restricted GLSL-shaped source above. Only the constructs it uses are supported. */
export function toWgsl(source: string): string {
  const type = (t: string) => ({ float: "f32", vec2: "vec2f", vec3: "vec3f", vec4: "vec4f", mat4: "mat4x4f" })[t] ?? t;
  return source
    .replace(/^(\s*)(float|vec2|vec3|vec4) (\w+)\(([^)]*)\) \{/gm, (_, indent: string, ret: string, name: string, args: string) =>
      `${indent}fn ${name}(${args.split(",").map((arg) => arg.trim().split(" ")).map(([t, n]) => `${n}: ${type(t!)}`).join(", ")}) -> ${type(ret)} {`)
    .replace(/^(\s*)(float|vec2|vec3|vec4) (\w+) = /gm, (_, indent: string, t: string, name: string) => `${indent}var ${name}: ${type(t)} = `)
    .replace(/\bvec([234])\(/g, "vec$1f(")
    .replace(/\bdFdx\(/g, "dpdx(").replace(/\bdFdy\(/g, "dpdy(");
}

/**
 * Removes `//` comments and blank lines from generated shader code. The source has no string literals, block comments
 * or line continuations, so the first `//` of a line always starts a comment; directives keep their own lines.
 */
export function stripShaderComments(source: string): string {
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    const comment = line.indexOf("//");
    const code = (comment < 0 ? line : line.slice(0, comment)).trimEnd();
    if (code) lines.push(code);
  }
  return lines.join("\n");
}

/**
 * Assembled water shader source per language: the plugin's vertex and fragment injections, the outline pass's
 * displacement and the Water Waves node's sources. `toWgsl` translates the GLSL-shaped chunks.
 */
import { ShaderLanguage } from "@babylonjs/core";
import { WATER_FFT_CASCADES_MAX, WATER_FOAM_WEIGHTS } from "@haptic/core";
import {
  cutSource, fftHelpers, fftTurnIn, fftTurnOut, fftTurnTensor, FOAM_FAR_PATCHES, HELPERS, ifFft, objectHelpers, REMOVAL_HELPER, SHADING_SLOPE_CAP,
  spectrumHelpers, spectrumNormalSource, spectrumRealisticSource, spectrumVertexSource, subsurfaceSource,
} from "./water-shader-chunks";
import {
  COLOR_LOCALS, COLOR_UNIFORMS, EDGE_FOAM_CALM, f, FFT, FFT_CASCADE_UNIFORMS, FFT_UNIFORMS, REFLECTS_OBJECTS, REFRACTION, SAMPLES_COPY, SPECTRUM_FOAM_SCALE,
  WATER_BLEND_DEFINE, WATER_GPU_WAVES_DEFINE,
} from "./water-shader-defines";

/**
 * Vertex stage of `SLATE_WATER_GPU_WAVES`, at CUSTOM_VERTEX_UPDATE_WORLDPOS: the spectrum's displacement
 * (`spectrumVertexSource`) at this vertex's world rest point. The rest grid carries its mesh spacing in
 * `slateWaterData.x` (the spectrum's mip) and its bank distance in `.y` (the finite-body fade of the horizontal offset).
 * Writes the displaced world position (the clip position, fog, shadows and clip planes follow it) and leaves the height
 * and offset for the varyings in `swvH` / `swvD`, so the fragment finds its rest point and contacts see the rendered
 * height. `slateWaterGridOffset` (xyz) is the world-space translation of the rest grid since its positions were uploaded
 * (Global Water's recentre, `waterGridOffset`): it is added before the rest point is taken, so the spectrum, bank terms
 * and `vPositionW` all see the translated grid. GLSL-shaped: `A.` attributes, `U.` uniforms, `S.` the view matrix's
 * owner and `O.` outputs are bound per language, then `toWgsl` translates it. Other passes that draw built-in water with
 * their own vertex shader (the shared outline mask) include the same displacement through `waterOutlineVertexSource`,
 * without the material's `vPositionW` output. `normal` (a Custom Material's Water Waves node, `waterWaveBlockSource`)
 * also leaves `swvNormal` (`spectrumNormalSource`), which the built-in fragment shader derives per pixel for itself;
 * `distance` is the eye-distance expression the spectrum's LOD reads.
 */
function vertexWaveSource(materialOutputs: boolean, normal = false, distance = "abs((S.view * worldPos).z)"): string {
  return `
#ifdef ${WATER_GPU_WAVES_DEFINE}
float swvSpacing = A.slateWaterData.x;
worldPos = vec4(worldPos.xyz + U.slateWaterGridOffset.xyz, worldPos.w);
vec2 swvRest = worldPos.xz;
float swvH = 0.0;
vec2 swvD = vec2(0.0);${spectrumVertexSource(distance, normal)}
float swvFade = U.slateWaterSwellInfo.x;
#ifdef ${WATER_BLEND_DEFINE}
swvFade = swvFade * A.slateWaterBlend.y;
#endif
float swvBankT = clamp(A.slateWaterData.y / max(swvFade, 0.000001), 0.0, 1.0);
float swvGain = mix(1.0, swvBankT * swvBankT * (3.0 - 2.0 * swvBankT), step(0.000001, swvFade));${normal ? spectrumNormalSource() : ""}
#ifdef ${WATER_BLEND_DEFINE}
swvH = swvH * A.slateWaterBlend.x;
swvD = swvD * A.slateWaterBlend.y;
#endif
swvD = swvD * swvGain;
worldPos = vec4(worldPos.xyz + vec3(swvD.x, swvH, swvD.y), worldPos.w);${materialOutputs ? "\nO.vPositionW = worldPos.xyz;" : ""}
#endif
`;
}

/**
 * Blending surfaces on the GPU path cull vertices this many of their own grid spacings, plus `BLEND_CULL_MARGIN` metres,
 * inside water they never draw (`VERTEX_VARYINGS`). A triangle's other vertices are at most √2 spacings away, and both
 * the ownership margin and the bank distance change by about a metre per metre (the margin's fit is approximate, hence
 * the slack), so they lie in that water too.
 */
const BLEND_CULL_CELLS = 2;
const BLEND_CULL_MARGIN = 1;

/**
 * Varyings at CUSTOM_VERTEX_MAIN_END, which runs after the world-position hook: GPU waves pass their own height and
 * offset, so the attribute copy must not overwrite them. `SW_CLIP_POSITION` is the clip position, bound per language.
 */
const VERTEX_VARYINGS = `
#ifdef ${WATER_GPU_WAVES_DEFINE}
O.vSlateWater = vec4(swvH, A.slateWaterData.yzw);
O.vSlateWaterFlow = vec4(A.slateWaterFlow.xz, swvD);
#else
O.vSlateWater = A.slateWaterData;
O.vSlateWaterFlow = vec4(A.slateWaterFlow.xz, A.slateWaterOffset);
#endif
O.vSlateWaterBaseNormal = A.slateWaterBaseNormal;
#ifdef ${WATER_BLEND_DEFINE}
O.vSlateWaterBlend = A.slateWaterBlend;
O.vSlateWaterBlendColors = A.slateWaterBlendColors;
#ifdef ${WATER_GPU_WAVES_DEFINE}
// Water this blending surface never draws (a neighbour's share, or past the blended shoreline) is discarded fragment by
// fragment, but only after the whole look has run on it, and where it overlaps the neighbour's surface the depth test
// cannot reject it. A vertex deeper in it than \`BLEND_CULL_CELLS\` of its own spacing plus \`BLEND_CULL_MARGIN\` metres
// belongs only to triangles all of whose vertices lie in it too (by the same attribute: both fields are distances), so
// every fragment of those triangles would discard: its clip depth moves past the far side of the clip volume (x, y and w
// unchanged, so the triangles it starts clip to within their own outline) and they rasterize nothing, in the depth
// pre-pass and the colour pass alike.
if (min(A.slateWaterData.y, A.slateWaterBlend.z) < -(${f(BLEND_CULL_CELLS)} * A.slateWaterData.x + ${f(BLEND_CULL_MARGIN)})) {
  SW_CLIP_POSITION.z = 2.0 * SW_CLIP_POSITION.w;
}
#endif
#endif
`;

/**
 * Binds the GLSL-shaped `A.` / `U.` / `O.` prefixes for one language, and `S.` (the view matrix's owner: the scene
 * uniform buffer in a material, plain uniforms in the outline mask) to `scene`'s WGSL prefix.
 */
function bindVertexSource(code: string, wgsl: boolean, scene = "scene."): string {
  return code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bA\./g, wgsl ? "vertexInputs." : "").replace(/\bO\./g, wgsl ? "vertexOutputs." : "")
    .replace(/\bS\./g, wgsl ? scene : "");
}

/** Vertex hooks for one language: the spectrum's sampler (with GPU waves), the displacement and the varyings. */
export function waterVertexSource(language: ShaderLanguage): { definitions: string; worldPosition: string; end: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const definitions = `\n#ifdef ${WATER_GPU_WAVES_DEFINE}${fftHelpers(wgsl)}#endif\n`;
  return wgsl
    ? { definitions, worldPosition: bindVertexSource(toWgsl(vertexWaveSource(true)), true), end: bindVertexSource(toWgsl(VERTEX_VARYINGS), true).replace(/\bSW_CLIP_POSITION\b/g, "vertexOutputs.position") }
    : { definitions, worldPosition: bindVertexSource(vertexWaveSource(true), false), end: bindVertexSource(VERTEX_VARYINGS, false).replace(/\bSW_CLIP_POSITION\b/g, "gl_Position") };
}

/**
 * Uniforms the vertex displacement reads (`bindWaterVertexUniforms` sets them, with `WATER_FFT_SAMPLER`): the bank fade
 * (`slateWaterSwellInfo.x`), the grid offset and the spectrum's.
 */
export const WATER_VERTEX_WAVE_UNIFORMS: readonly string[] = ["slateWaterSwellInfo", "slateWaterGridOffset", ...FFT_UNIFORMS];
/** The surface's water clock in seconds (x), for a Custom Material's Water Waves node (`WaterVertexWaves.bind`). */
export const WATER_CLOCK_UNIFORM = "slateWaterClock";
/** `vertexWaveDefines` per blend state (off, on) and spectrum cascades (1-3): built once. */
export const VERTEX_WAVE_DEFINES: ReadonlyArray<ReadonlyArray<readonly string[]>> = [false, true].map((blend) =>
  Array.from({ length: WATER_FFT_CASCADES_MAX + 1 }, (_, cascades) => [
    `#define ${WATER_GPU_WAVES_DEFINE}`, `#define ${FFT} ${Math.max(1, cascades)}`, ...(blend ? [`#define ${WATER_BLEND_DEFINE}`] : []),
  ]));
/** `vertexWaveAttributes` per blend state (off, on). */
export const VERTEX_WAVE_ATTRIBUTES: ReadonlyArray<readonly string[]> = [["slateWaterData"], ["slateWaterData", "slateWaterBlend"]];

/**
 * The displacement for another pass's vertex shader that computes a `worldPos` vec4 from the same world matrix and has a
 * `view` matrix uniform (the shared outline mask): declarations of its attribute, uniforms and the spectrum's sampler,
 * and the displacement to insert after `worldPos`. Both compile only under `SLATE_WATER_GPU_WAVES`, so the pass's other
 * programs are unchanged.
 */
export function waterOutlineVertexSource(language: ShaderLanguage): { declarations: string; displacement: string } {
  const key = language === ShaderLanguage.WGSL ? "wgsl" : "glsl";
  let source = outlineVertexSources.get(key);
  if (!source) outlineVertexSources.set(key, source = buildOutlineVertexSource(language));
  return source;
}
const outlineVertexSources = new Map<string, { declarations: string; displacement: string }>();
function buildOutlineVertexSource(language: ShaderLanguage): { declarations: string; displacement: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const uniforms = WATER_VERTEX_WAVE_UNIFORMS.map((name) => (wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`)).join("\n");
  const attribute = wgsl ? "attribute slateWaterData: vec4f;" : "attribute vec4 slateWaterData;";
  const blend = `#ifdef ${WATER_BLEND_DEFINE}\n${wgsl ? "attribute slateWaterBlend: vec4f;" : "attribute vec4 slateWaterBlend;"}\n#endif`;
  const displacement = vertexWaveSource(false);
  return {
    declarations: `\n${stripShaderComments(`#ifdef ${WATER_GPU_WAVES_DEFINE}\n${attribute}\n${blend}\n${uniforms}${fftHelpers(wgsl)}#endif`)}\n`,
    displacement: `\n${stripShaderComments(bindVertexSource(wgsl ? toWgsl(displacement) : displacement, wgsl, "uniforms."))}\n`,
  };
}

const blockWaveSources = new Map<ShaderLanguage, string>();
/**
 * The Water Waves node's vertex code for one language: `vertexWaveSource` with the normal, bound and translated like the
 * plugin's, its eye distance from `slateWaterEye` (the camera's world position relative to the rest positions). It reads
 * and writes a `worldPos` vec4 (rest point in, displaced point out) and leaves `swvH` (height), `swvD` (horizontal offset)
 * and `swvNormal`, under `SLATE_WATER_GPU_WAVES`; it reads `slateWaterData` and `slateWaterBaseNormal`, and under
 * `SLATE_WATER_BLEND` `slateWaterBlend`, as attributes. Built once.
 */
export function waterWaveBlockSource(language: ShaderLanguage): string {
  let source = blockWaveSources.get(language);
  if (!source) {
    const wgsl = language === ShaderLanguage.WGSL, code = vertexWaveSource(false, true, "length(worldPos.xyz - U.slateWaterEye.xyz)");
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
/**
 * Varying the Water Waves node's vertex stage hands its fragment stage: (bank gain × offset share, height share, and
 * while blending the union bank distance and ownership margin, both in metres).
 */
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
float swvKeepBank = 1.0;
float swvKeepMargin = 1.0;
#ifdef ${WATER_BLEND_DEFINE}
swvKeepBank = A.slateWaterData.y;
swvKeepMargin = A.slateWaterBlend.z;
#endif
${out} = vec4(swvGain * swvDs, swvHs, swvKeepBank, swvKeepMargin);
}
#endif
`;
}

/**
 * The Water Waves node's fragment code: the spectrum at this pixel's rest point (`rest`, the interpolated undisplaced
 * world position plus the grid offset), every cascade through its mips as built-in water samples it
 * (`spectrumSurfaceSource`): it discards what a blending surface does not own, then gives the displaced surface's
 * normal over the mesh's base normal (`base`), the height, and
 * FFT-Ocean's crest foam from the persistent turbulence with the asset's Crest Foam and Foam Amount, and the subsurface
 * light built-in water draws (`subsurfaceSource`). Writes `swnNormal`, `swnHeight`, `swnFoam`, `swnSubsurface` and
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
vec4 swnShares = ${varying};
// A blending surface draws only the water it owns inside the blended shoreline, as built-in water does (\`cutSource\`).
if (min(swnShares.z, swnShares.w + 0.015) < 0.0) { discard; }
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
 * CUSTOM_FRAGMENT_BEFORE_FOG. The colour pass first discards removed water (`swRemoved`, see `cutSource`): the look's
 * derivatives ran with every fragment of the quad alive, and nothing from here on takes one.
 *
 * Realistic colour is premultiplied by coverage: undo it for Babylon's non-premultiplied blend, fog and image
 * processing. In an 8-bit display target, light brighter than the coverage raises it instead of clipping, and the raised
 * coverage hides that much more of the background behind the blend. With the refracted copy (`swBehindCopy`: the copy at this
 * pixel, the background the blend would show) the share it hides is added back as refracted light, and the coverage
 * solves for that too (per channel, (light − copy · a) / (1 − copy)): glints, foam and bright reflections over shallows
 * add to the bed seen through them instead of replacing it with a darker ring. Without the copy the raise stays as it is
 * (the least coverage that keeps the light from clipping). In Scene Linear (`IMAGEPROCESSINGPOSTPROCESS`, a half-float
 * target that never clips at 1) coverage is the water's own and nothing is raised.
 *
 * The refracted scene (`swRefracted`; `SLATE_WATER_REFRACTION`) is light from behind the surface, already fogged by its
 * own materials. Its share `swRefractedWeight` is the coverage the water's own light leaves it (the output's coverage
 * less the water's blend coverage), whatever tint, caustics or foam `swRefracted` carries. With the copy the water
 * covers that share too, so Babylon's fog below would fog the background again and add its fog colour over it: the
 * refracted light is pre-divided by the fog factor, less the fog colour at its share, so the result equals blending
 * (the water's fog on its own light only). The factor is the weight Babylon's PBR fog mixes with
 * (`toLinearSpace(CalcFogFactor())` under `PBR`, which water materials are).
 */
function beforeFogSource(wgsl: boolean): string {
  const v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4", f1 = wgsl ? "f32" : "float";
  const declare = (type: string, name: string, value: string) => (wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`);
  const brightest = (c: string) => `max(${c}.r, max(${c}.g, ${c}.b))`;
  return [
    // Removed water leaves the colour pass here, after every derivative of the look (the depth pre-pass left in `cutSource`).
    "#ifndef DEPTHPREPASS",
    "if (swRemoved) { discard; }",
    "#endif",
    // Realistic coverage, before the refracted light takes its fog: the raise below can add to it.
    "#ifdef IMAGEPROCESSINGPOSTPROCESS",
    declare(f1, "swCover", "clamp(finalColor.a, 0.02, 1.0)"),
    `#elif defined(${REFRACTION})`,
    declare(v3, "swBehindCopy", "swSceneColor(swScreenUv)"),
    declare(v3, "swNeed", `(finalColor.rgb + swRefracted - swBehindCopy * finalColor.a) / max(${v3}(1.0) - swBehindCopy, ${v3}(0.001))`),
    declare(f1, "swCover", `clamp(max(finalColor.a, ${brightest("swNeed")}), 0.02, 1.0)`),
    declare(f1, "swRaised", "max(swCover - finalColor.a, 0.0)"),
    "swRefracted += swBehindCopy * swRaised;",
    "swRefractedWeight += swRaised;",
    "#else",
    declare(f1, "swCover", `clamp(max(finalColor.a, ${brightest("finalColor")}), 0.02, 1.0)`),
    "#endif",
    `#ifdef ${REFRACTION}`,
    declare(v3, "swRefractedOut", "swRefracted"),
    "#ifdef FOG",
    declare(f1, "swFogKeep", "max(toLinearSpace(CalcFogFactor()), 0.01)"),
    `swRefractedOut = (swRefracted - ${wgsl ? "uniforms." : ""}vFogColor * ((1.0 - swFogKeep) * swRefractedWeight)) / swFogKeep;`,
    "#endif",
    "#endif",
    `#ifdef ${REFRACTION}`,
    `finalColor = ${v4}(finalColor.rgb + swRefractedOut, finalColor.a);`,
    "#endif",
    `finalColor = ${v4}(finalColor.rgb / swCover, swCover);`,
    `#if ${SAMPLES_COPY}`,
    `finalColor = ${v4}(mix(finalColor.rgb, swHorC, swHorW), mix(finalColor.a, 1.0, swHorW));`,
    "#endif",
    // Open-water edges fade out (`swOpenFade`).
    "finalColor.a *= swOpenFade;",
  ].join("\n");
}

/** One more read of the contact field at an explicit level, legal in any control flow (Realistic's wake taps). */
const CONTACT_TAP_GLSL = "vec4 swContactAt(vec2 uv) { return texture2DLodEXT(slateWaterContactSampler, uv, 0.0); }\n";
const CONTACT_TAP_WGSL = "fn swContactAt(uv: vec2f) -> vec4f { return textureSampleLevel(slateWaterContactSampler, slateWaterContactSamplerSampler, uv, 0.0); }\n";

/**
 * The look sources read the asset's colours through the cut code's blended locals (`COLOR_LOCALS`) and its wave height
 * through the blended swell scale, so a blending surface shades as the mixed body (a plain surface folds both away).
 */
function blendColors(source: string): string {
  let out = source.replace(/\bU\.slateWaterWaves\.x\b/g, "(U.slateWaterWaves.x * swBlendH)");
  COLOR_UNIFORMS.forEach((name, i) => { out = out.replace(new RegExp(`\\bU\\.${name}\\b`, "g"), COLOR_LOCALS[i]!); });
  return out;
}

export function waterShaderSource(language: ShaderLanguage): { helpers: string; cut: string; main: string } {
  const wgsl = language === ShaderLanguage.WGSL;
  const bind = (code: string) => code.replace(/\bU\./g, wgsl ? "uniforms." : "").replace(/\bIN\./g, wgsl ? "fragmentInputs." : "").replace(/\bS\./g, wgsl ? "scene." : "")
    // The fragment's framebuffer position (on render targets both backends store rows in the same order as uv).
    .replace(/\bSW_FRAG_COORD\b/g, wgsl ? "fragmentInputs.position" : "gl_FragCoord")
    .replace(/\bSW_TO_LINEAR\(/g, wgsl ? "toLinearSpaceVec3(" : "toLinearSpace(");
  const samplerDeclaration = wgsl
    ? "var slateWaterFieldSamplerSampler: sampler;\nvar slateWaterFieldSampler: texture_2d<f32>;\nvar slateWaterContactSamplerSampler: sampler;\nvar slateWaterContactSampler: texture_2d<f32>;\n"
    : "uniform sampler2D slateWaterFieldSampler;\nuniform sampler2D slateWaterContactSampler;\n";
  // Written by the realistic main code and read inside Babylon's reflectivity block (a separate function).
  const roughnessGlobals = wgsl
    ? "var<private> swSlopeVariance: f32 = 0.0;\nvar<private> swMatte: f32 = 0.0;\nvar<private> swSharp: f32 = 1.0;\nvar<private> swReflKeep: f32 = 1.0;\n"
    : "float swSlopeVariance = 0.0;\nfloat swMatte = 0.0;\nfloat swSharp = 1.0;\nfloat swReflKeep = 1.0;\n";
  return wgsl
    ? {
      helpers: samplerDeclaration + roughnessGlobals + toWgsl(HELPERS + REMOVAL_HELPER) + CONTACT_TAP_WGSL + objectHelpers(true) + fftHelpers(true) + spectrumHelpers(true),
      cut: bind(toWgsl(cutSource(true))), main: bind(toWgsl(blendColors(spectrumRealisticSource()))),
    }
    : {
      helpers: samplerDeclaration + roughnessGlobals + HELPERS + REMOVAL_HELPER + CONTACT_TAP_GLSL + objectHelpers(false) + fftHelpers(false) + spectrumHelpers(false),
      cut: bind(cutSource(false)), main: bind(blendColors(spectrumRealisticSource())),
    };
}

type VertexPoint = "CUSTOM_VERTEX_DEFINITIONS" | "CUSTOM_VERTEX_UPDATE_WORLDPOS" | "CUSTOM_VERTEX_MAIN_END";
const FRAGMENT_POINTS = [
  "CUSTOM_FRAGMENT_DEFINITIONS", "CUSTOM_FRAGMENT_UPDATE_ALPHA", "CUSTOM_FRAGMENT_BEFORE_LIGHTS", "CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS",
  "CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION", "CUSTOM_FRAGMENT_BEFORE_FOG",
] as const;
/** The code a stage injects into the PBR shader, by injection point. */
function waterInjection(stage: "vertex" | "fragment", language: ShaderLanguage): Record<string, string> {
  const wgsl = language === ShaderLanguage.WGSL;
  const v3 = wgsl ? "vec3f" : "vec3", v4 = wgsl ? "vec4f" : "vec4";
  // Babylon's shader processors are line-based: every attribute, varying and sampler needs its own line.
  const varying = (type: string, name: string) => (wgsl ? `varying ${name}: ${type};` : `varying ${type} ${name};`) + "\n";
  // vSlateWaterFlow packs the world current (x, z) and the Gerstner offset (Dx, Dz), so the fragment finds its rest point.
  const varyings = varying(v4, "vSlateWater") + varying(v4, "vSlateWaterFlow") + varying(v3, "vSlateWaterBaseNormal")
    + `#ifdef ${WATER_BLEND_DEFINE}\n` + varying(v4, "vSlateWaterBlend") + varying(wgsl ? "vec2f" : "vec2", "vSlateWaterBlendColors") + "#endif\n";
  const blendAttribute = `#ifdef ${WATER_BLEND_DEFINE}\n${wgsl ? "attribute slateWaterBlend: vec4f;" : "attribute vec4 slateWaterBlend;"}\n`
    + `${wgsl ? "attribute slateWaterBlendColors: vec2f;" : "attribute vec2 slateWaterBlendColors;"}\n#endif\n`;
  if (stage === "vertex") {
    const vertex = waterVertexSource(language);
    return {
      CUSTOM_VERTEX_DEFINITIONS: (wgsl
        ? "attribute slateWaterData: vec4f;\nattribute slateWaterFlow: vec3f;\nattribute slateWaterBaseNormal: vec3f;\nattribute slateWaterOffset: vec2f;\n"
        : "attribute vec4 slateWaterData;\nattribute vec3 slateWaterFlow;\nattribute vec3 slateWaterBaseNormal;\nattribute vec2 slateWaterOffset;\n") + blendAttribute + varyings + vertex.definitions,
      CUSTOM_VERTEX_UPDATE_WORLDPOS: vertex.worldPosition,
      CUSTOM_VERTEX_MAIN_END: vertex.end,
    } satisfies Record<VertexPoint, string>;
  }
  const source = waterShaderSource(language);
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: varyings + source.helpers,
    CUSTOM_FRAGMENT_UPDATE_ALPHA: source.cut,
    CUSTOM_FRAGMENT_BEFORE_LIGHTS: source.main,
    // Realistic: filtered chop widens the GGX lobe with distance, and foam is fully rough.
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS:
      "metallicRoughness.g = mix(sqrt(sqrt(metallicRoughness.g * metallicRoughness.g * metallicRoughness.g * metallicRoughness.g * swSharp + 2.0 * swSlopeVariance)), 1.0, swMatte);",
    // Foam and the mesh edge hide the mirror; without an environment, the analytic scene sky (`swSkyRefl`) stands in.
    // Reflected objects (screen-space or planar) replace the sky or environment where found, with the water's own
    // Fresnel and Reflection Strength.
    CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: [
      "finalEmissive += swEmissive;",
      "#ifdef REFLECTION",
      // The facet's own reflectance (`swFres`, the environment BRDF of the facet normal) replaces Babylon's, which the
      // lifted shading normal would dim toward the horizon; rays leaving below the horizon keep less (`swReflKeep`).
      `finalRadianceScaled = reflectionOut.environmentRadiance.rgb * (${wgsl ? "uniforms." : ""}vLightingIntensity.z * swFres * swReflKeep);`,
      `#if ${REFLECTS_OBJECTS}`,
      `finalRadianceScaled = mix(finalRadianceScaled, swObjRefl.rgb * (swFres * ${wgsl ? "uniforms." : ""}slateWaterDeep.w), swObjRefl.a);`,
      "#endif",
      "finalRadianceScaled *= swGloss;",
      "#else",
      `#if ${REFLECTS_OBJECTS}`,
      `finalEmissive += mix(swSkyRefl * swReflKeep, swObjRefl.rgb * ${wgsl ? "uniforms." : ""}slateWaterDeep.w, swObjRefl.a) * (swFres * swGloss);`,
      "#else",
      "finalEmissive += swSkyRefl * (swFres * swGloss * swReflKeep);",
      "#endif",
      "#endif",
      "#ifdef SPECULARTERM",
      // The sun's lobe is dimmed close by (where facet glints carry it), log-compressed where bright, and far away
      // broken into glitter (see the sun in `realisticSource`).
      "finalSpecularScaled *= swGloss * swSunReach * swSpecKeep;",
      `finalSpecularScaled *= log(1.0 + dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11)) * swSpecSquash + 0.0001) / (dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11)) * swSpecSquash + 0.0001);`,
      // The glitter's weight rises smoothly with the lobe's luminance (a threshold on it drew an outline around every contour of the slope).
      `finalSpecularScaled *= mix(1.0, swSpecMod, swSpecModW * 0.6 * dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11)) / (dot(finalSpecularScaled, ${v3}(0.3, 0.59, 0.11)) + 0.15));`,
      "#endif",
    ].join("\n"),
    CUSTOM_FRAGMENT_BEFORE_FOG: beforeFogSource(wgsl),
  } satisfies Record<(typeof FRAGMENT_POINTS)[number], string>;
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

const injections = new Map<string, Readonly<Record<string, string>>>();
/**
 * `waterInjection`'s points with comments stripped, built once per stage and language. Babylon collects the fragment's
 * point names when the plugin is added (no compile yet), so the fragment builds on the first read of a value.
 */
export function injectionFor(stage: "vertex" | "fragment", language: ShaderLanguage): Readonly<Record<string, string>> {
  const key = `${stage}:${language === ShaderLanguage.WGSL ? "wgsl" : "glsl"}`;
  let injection = injections.get(key);
  if (!injection) {
    const build = () => Object.fromEntries(Object.entries(waterInjection(stage, language)).map(([point, code]) => [point, stripShaderComments(code)]));
    injection = stage === "fragment" ? lazyInjection(FRAGMENT_POINTS, build) : Object.freeze(build());
    injections.set(key, injection);
  }
  return injection;
}
function lazyInjection(points: readonly string[], build: () => Record<string, string>): Readonly<Record<string, string>> {
  let built: Record<string, string> | undefined;
  return Object.defineProperties({}, Object.fromEntries(points.map((point) => [point, { enumerable: true, get: () => (built ??= build())[point] }])));
}

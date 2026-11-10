import type { DrawPass, RenderDiagnostics } from "@haptic/render";
import type { PlaySessionResult } from "./play-session";
import type { PlayProbe, ViewportProbe } from "./runtime-probes";
import { RENDER_QUALITY_PROFILES, SHADOW_PROFILES } from "@haptic/core";
import { describeError } from "../lib/diagnostic-info";
import { FEATURE_TEST_CHECK_SCENES } from "./feature-test-check-scenes";

/** Console commands each scene runs in Play; the main scene exercises the full set. */
function featureTestCheckCommands(sceneName: string, mode: FeatureTestCheckMode): string[] {
  if (sceneName === "main" && mode === "full") return ["ft_stats", "ft_spawn 10", "ft_stats", "ft_stream", "ft_cel", "ft_pbr"];
  // Occlusion Culling is on at every tier; the yardstick turns it on in case the project turned it off.
  if (sceneName === "FT_Occlusion") return ["ft_stats", "ft_occlusion"];
  return ["ft_stats"];
}

export type FeatureTestCheckMode = "quick" | "full" | "benchmark" | "breakdown" | "profile";

/**
 * Performance profiles a Benchmark sweeps per scene: each quality tier. A
 * profile's commands can rebuild shaders and render targets, so sampling waits
 * for the view to draw again.
 */
export const FEATURE_TEST_BENCHMARK_PROFILES: readonly { label: string; commands: readonly string[] }[] = [
  { label: "low", commands: ["quality low"] },
  { label: "medium", commands: ["quality medium"] },
  { label: "high", commands: ["quality high"] },
  { label: "ultra", commands: ["quality ultra"] },
];

/**
 * How a Breakdown measures each feature's GPU cost. A tablet GPU near its cap runs at two speeds with hysteresis, so a
 * change measured there says only whether the step crossed the cap, not what the feature costs.
 * - `add-one` (the default): from a light base well below the cap (`FEATURE_TEST_BREAKDOWN_BASES`), each step turns
 *   one feature on at its Medium value, so every sample stays below the cap and a change is that feature's own cost.
 * - `remove-one`: from the Medium tier, each step turns one feature off or lowers one cost: what it saves at a shipping
 *   tier, meaningful only while that tier is below the cap.
 */
/** `water`: what each part of water costs, removed one at a time from the Medium tier at half resolution (`FEATURE_TEST_BREAKDOWN_WATER_STEPS`). */
export type FeatureTestBreakdownMethod = "add-one" | "remove-one" | "water";
export const FEATURE_TEST_BREAKDOWN_METHODS: readonly FeatureTestBreakdownMethod[] = ["add-one", "remove-one", "water"];
export const FEATURE_TEST_BREAKDOWN_DEFAULT_METHOD: FeatureTestBreakdownMethod = "add-one";

/** What a Breakdown's baselines run: applied after `quality reset` before the warm-up and after every step. */
export interface FeatureTestBreakdownBase {
  /** How the report names it (`FeatureTestBreakdownInfo.tier`). */
  label: string;
  commands: readonly string[];
}

const MEDIUM = { ...RENDER_QUALITY_PROFILES.medium, shadows: SHADOW_PROFILES.medium };

export const FEATURE_TEST_BREAKDOWN_BASES: Readonly<Record<FeatureTestBreakdownMethod, FeatureTestBreakdownBase>> = {
  "add-one": {
    label: "low at resolution 0.5, without post-processing, anti-aliasing, water reflections, water refraction, occlusion culling or captures; shadow filter low; water detail low",
    // Each feature a step turns on is off here by name, so the base does not depend on what the Low tier holds.
    commands: [
      "quality low",
      "quality resolution scale 0.5",
      "quality shadows filter low",
      "quality water shadingDetail low",
      "quality water reflections sky",
      "quality water refraction off",
      "quality geometry occlusion off",
      "quality postprocessing antialiasing off",
      "quality postprocessing ambientOcclusion off",
      "quality postprocessing reflections off",
      "quality postprocessing volumetricLighting off",
      "postprocessing off",
      "rendertargets off",
    ],
  },
  "remove-one": {
    label: "medium",
    // Tiers below Ultra turn dynamic resolution on, which a Feature Test project keeps off so the workload stays fixed.
    commands: ["quality medium", "quality resolution reset"],
  },
  // Half resolution keeps a tablet's GPU below the point where it drops to its slower speed (SATURATED at full
  // resolution), so each water step's change is that part's own cost.
  water: { label: "medium at resolution 0.5", commands: ["quality medium", "quality resolution scale 0.5"] },
};

/**
 * An add-one Breakdown keeps every sample below this GPU-busy time (mean frame time without fences): past it the GPU
 * nears its cap and may change speed, so a baseline over it flags the run OVER CAP.
 */
export const ADD_ONE_CAP_MS = 30;

/** Scenes a Breakdown measures unless every scene is asked for: the GPU-heaviest, and the occlusion culling yardstick. */
export const FEATURE_TEST_BREAKDOWN_SCENES = FEATURE_TEST_CHECK_SCENES.filter((scene) => scene.name === "FT_World" || scene.name === "FT_Occlusion");
/** A Water Breakdown's scenes unless every scene is asked for: FT_World, which holds every water body kind. */
export const FEATURE_TEST_BREAKDOWN_WATER_SCENES = FEATURE_TEST_CHECK_SCENES.filter((scene) => scene.name === "FT_World");

/** A Breakdown step: its commands, what undoes them besides `quality reset` and the base, and the render settings it may change. */
export interface FeatureTestBreakdownStep {
  label: string;
  commands: readonly string[];
  restore?: readonly string[];
  /** A baseline: the base, nothing changed. */
  baseline?: boolean;
  /**
   * Render-settings fingerprint fields (`RenderDiagnostics.settings`) the step changes: any other change is flagged,
   * and a step that changes none of them is skipped (its setting already holds that value).
   */
  fields?: readonly string[];
  /**
   * Remove-one and Profile: its saving overlaps another step's (a lower setting of a feature another step turns off, one
   * effect of the post-processing another step turns off, or a resolution scale that shrinks every pass), so the
   * NON-ADDITIVE check and a Profile's sum of savings leave it out.
   */
  overlaps?: boolean;
  /** Add-one: the label of another step whose cost this one includes (AO and SSR run in the post-processing stack). */
  includes?: string;
}

const POST_FIELDS = [
  "post.scale", "post.ambientOcclusion", "post.reflections", "post.volumetricLighting", "post.antiAliasing", "post.samples",
] as const;
const ANTI_ALIASING_FIELDS = ["post.antiAliasing", "post.samples"] as const;
const WATER_DETAIL_FIELDS = ["water.shadingDetail", "water.fft"] as const;

/**
 * Remove-one (`FEATURE_TEST_BREAKDOWN_BASES["remove-one"]`, the Medium tier): one feature off (or one cost lowered) at
 * a time, so its change against the baselines around it is what that feature saves. At Medium, `shadows medium`,
 * `water detail medium`, `volumetrics off` and `MSAA 2x` already hold and are skipped.
 */
export const FEATURE_TEST_BREAKDOWN_STEPS: readonly FeatureTestBreakdownStep[] = [
  { label: "shadows off", commands: ["quality shadows enabled off"], fields: ["shadows", "shadows.filter"] },
  { label: "shadows medium", commands: ["quality shadows medium"], fields: ["shadows", "shadows.filter"], overlaps: true },
  // The shadow filter alone: Castaño's 5 × 5 kernel (nine taps) in place of the level's (High's 7 × 7, sixteen).
  { label: "shadow filter medium", commands: ["quality shadows filter medium"], fields: ["shadows.filter"], overlaps: true },
  { label: "water refraction off", commands: ["quality water refraction off"], fields: ["water.refraction"] },
  { label: "water reflections sky", commands: ["quality water reflections sky"], fields: ["water.reflections"] },
  { label: "water detail low", commands: ["quality water shadingDetail low"], fields: WATER_DETAIL_FIELDS },
  { label: "water detail medium", commands: ["quality water shadingDetail medium"], fields: WATER_DETAIL_FIELDS, overlaps: true },
  { label: "post low", commands: ["quality postprocessing low"], fields: POST_FIELDS, overlaps: true },
  { label: "AO off", commands: ["quality postprocessing ambientOcclusion off"], fields: ["post.ambientOcclusion"], overlaps: true },
  { label: "SSR off", commands: ["quality postprocessing reflections off"], fields: ["post.reflections"], overlaps: true },
  { label: "volumetrics off", commands: ["quality postprocessing volumetricLighting off"], fields: ["post.volumetricLighting"], overlaps: true },
  { label: "MSAA off", commands: ["quality postprocessing antialiasing off"], fields: ANTI_ALIASING_FIELDS },
  // Its saving is part of "MSAA off": a lower setting of the same feature.
  { label: "MSAA 2x", commands: ["quality postprocessing antialiasing msaa2"], fields: ANTI_ALIASING_FIELDS, overlaps: true },
  { label: "post off", commands: ["postprocessing off"], restore: ["postprocessing on"], fields: ["post.enabled"] },
  { label: "captures off", commands: ["rendertargets off"], restore: ["rendertargets on"], fields: ["captures"] },
  { label: "resolution 0.5", commands: ["quality resolution scale 0.5"], fields: ["resolution.scale"], overlaps: true },
];

/**
 * Add-one (`FEATURE_TEST_BREAKDOWN_BASES["add-one"]`): one feature on at its Medium value at a time, so its change
 * against the baselines around it is that feature's own cost below the GPU cap. The base's commands undo each step.
 */
export const FEATURE_TEST_BREAKDOWN_ADD_ONE_STEPS: readonly FeatureTestBreakdownStep[] = [
  { label: "MSAA 2x", commands: ["quality postprocessing antialiasing msaa2"], fields: ANTI_ALIASING_FIELDS },
  { label: "MSAA 4x", commands: ["quality postprocessing antialiasing msaa4"], fields: ANTI_ALIASING_FIELDS },
  // FXAA runs in the post-processing stack, so its step includes it, as AO's and SSR's do.
  {
    label: "AA fxaa", commands: ["postprocessing on", "quality postprocessing antialiasing fxaa"],
    fields: ["post.enabled", ...ANTI_ALIASING_FIELDS], includes: "post-processing",
  },
  {
    label: `shadow filter ${MEDIUM.shadows.filterQuality}`,
    commands: [`quality shadows filter ${MEDIUM.shadows.filterQuality}`], fields: ["shadows.filter"],
  },
  // FXAA, AO and SSR run in the post-processing stack, so their steps include it; this one measures the stack alone.
  { label: "post-processing", commands: ["postprocessing on"], fields: ["post.enabled"] },
  {
    label: "AO", commands: ["postprocessing on", "quality postprocessing ambientOcclusion on"],
    fields: ["post.enabled", "post.ambientOcclusion"], includes: "post-processing",
  },
  {
    label: "SSR", commands: ["postprocessing on", "quality postprocessing reflections on"],
    fields: ["post.enabled", "post.reflections"], includes: "post-processing",
  },
  // Each from the base on its own; the notes name the FFT grid it ran, resolution-independent work the detail may change.
  { label: "water detail medium", commands: ["quality water shadingDetail medium"], fields: WATER_DETAIL_FIELDS },
  { label: "water detail high", commands: ["quality water shadingDetail high"], fields: WATER_DETAIL_FIELDS },
  {
    label: "water refraction",
    commands: ["quality water refraction on", `quality water refractionScale ${MEDIUM.water.refractionScale}`],
    fields: ["water.refraction", "water.refractionScale"],
  },
  // Medium's own reflections march the scene copy; planar, which renders the scene again for flat water, is High's.
  {
    label: "screen-space water reflection",
    commands: ["quality water reflections screenSpace", `quality water reflectionSteps ${MEDIUM.water.reflectionSteps}`],
    fields: ["water.reflections"],
  },
  {
    label: "planar water reflection",
    commands: ["quality water reflections planar", `quality water planarScale ${MEDIUM.water.planarScale}`],
    fields: ["water.reflections", "water.planarScale"],
  },
  { label: "captures", commands: ["rendertargets on"], fields: ["captures"] },
  { label: "resolution 1.0", commands: [`quality resolution scale ${MEDIUM.resolution.scale}`], fields: ["resolution.scale"] },
];

/** A `waterdebug` part off, undone by switching it back on (`quality reset` leaves debug switches as they are). */
const waterPartOff = (part: string, label: string): FeatureTestBreakdownStep => ({
  label, commands: [`waterdebug ${part} off`], restore: [`waterdebug ${part} on`], fields: ["water.debug"], overlaps: true,
});

/**
 * Water (`FEATURE_TEST_BREAKDOWN_BASES.water`, the Medium tier at half resolution): every water surface off, then one part of water off, or
 * one water setting lowered, at a time. Every step but `water off` is a share of what that one saves (`overlaps`). At
 * Medium, Contact Resolution 256 already holds. Medium's FFT Size and Water Mesh Density are already the lowest, so
 * those two steps raise them to the previous Medium's (128, 0.75): their change is what that would cost.
 */
export const FEATURE_TEST_BREAKDOWN_WATER_STEPS: readonly FeatureTestBreakdownStep[] = [
  { label: "water off", commands: ["waterdebug water off"], restore: ["waterdebug water on"], fields: ["water.debug"] },
  waterPartOff("prepass", "water pre-pass off"),
  waterPartOff("lighting", "water lighting off"),
  waterPartOff("shadows", "water shadows off"),
  waterPartOff("waves", "water waves off"),
  waterPartOff("foam", "water foam off"),
  { label: "water reflections sky", commands: ["quality water reflections sky"], fields: ["water.reflections"], overlaps: true },
  { label: "water refraction off", commands: ["quality water refraction off"], fields: ["water.refraction"], overlaps: true },
  { label: "water detail low", commands: ["quality water shadingDetail low"], fields: WATER_DETAIL_FIELDS, overlaps: true },
  { label: "water fft 1 cascade", commands: ["quality water fftCascades 1"], fields: ["water.fft"], overlaps: true },
  { label: "water fft 128", commands: ["quality water fftSize 128"], fields: ["water.fft"], overlaps: true },
  { label: "water mesh 0.75", commands: ["quality water meshDensity 0.75"], fields: ["water.meshDensity"], overlaps: true },
];

/** The scenes a Breakdown by `method` measures: every Feature Test scene with `allScenes`. */
export function featureTestBreakdownScenes(method: FeatureTestBreakdownMethod, allScenes: boolean): readonly { name: string; path: string }[] {
  if (allScenes) return FEATURE_TEST_CHECK_SCENES;
  return method === "water" ? FEATURE_TEST_BREAKDOWN_WATER_SCENES : FEATURE_TEST_BREAKDOWN_SCENES;
}

/** The only scene a Profile plays: the main scene, whose frame the session's own quality tier draws. */
export const FEATURE_TEST_PROFILE_SCENES = FEATURE_TEST_CHECK_SCENES.filter((scene) => scene.name === "main");

/** The session before a Profile's first step: what its toggling steps turn back to. */
export interface FeatureTestProfileState {
  /** Occlusion culling (`geometry.occlusion`): its step turns it to the other value. */
  occlusion: boolean;
  /** The Engine's frames in flight (`framesinflight`, kept across Play sessions): its step turns them off, then back. */
  framesInFlight: "off" | 2 | 3;
  /** Whether post-processing runs and every-frame captures draw: their steps turn them off, then back. */
  postProcessing: boolean;
  captures: boolean;
}

/** The session's state from a baseline's settings fingerprint and its frames in flight; a missing field reads as Play's default. */
export function profileState(settings: Readonly<Record<string, string>> | undefined, framesInFlight: "off" | 2 | 3 | undefined): FeatureTestProfileState {
  const stored = settings?.["presentation.framesInFlight"];
  return {
    occlusion: settings?.["geometry.occlusion"] !== "false",
    framesInFlight: framesInFlight ?? (stored === "off" ? "off" : stored === "3" ? 3 : 2),
    postProcessing: settings?.["post.enabled"] !== "false",
    captures: settings?.captures !== "suspended",
  };
}

const GEOMETRY_EFFECT_FIELDS = ["post.ambientOcclusion", "post.reflections", "post.volumetricLighting", "shadows.screen"] as const;

/**
 * A Profile's steps (`featureTestProfilePlan`), each on top of the session's own quality tier and undone by `quality
 * reset` and its `restore` before the next, so its change against the baselines around it is what it saves at that
 * tier. Steps marked `overlaps` save part of another step's saving (a lower setting of a feature another step turns
 * off, an effect the post-processing or geometry step turns off too, a resolution that shrinks every pass).
 */
export function featureTestProfileSteps(state: FeatureTestProfileState): FeatureTestBreakdownStep[] {
  return [
    { label: "captures off", commands: ["rendertargets off"], restore: [`rendertargets ${state.captures ? "on" : "off"}`], fields: ["captures"] },
    { label: "shadows off", commands: ["quality shadows enabled off"], fields: ["shadows", "shadows.filter"] },
    // Medium's shadow level: its map size, cascades, filter, Screen-Space Shadows and Reflection Shadows (both off at Medium).
    {
      label: "shadows medium", commands: ["quality shadows medium"], fields: ["shadows", "shadows.filter", "shadows.screen", "shadows.reflections"],
      overlaps: true,
    },
    { label: "screen shadows off", commands: ["quality shadows screen off"], fields: ["shadows.screen"] },
    // The reflections' own sun maps (on at Ultra): the main scene's Mirrors.
    { label: "reflection shadows off", commands: ["quality shadows reflections off"], fields: ["shadows.reflections"] },
    { label: "AO off", commands: ["quality postprocessing ambientOcclusion off"], fields: ["post.ambientOcclusion"], overlaps: true },
    { label: "SSR off", commands: ["quality postprocessing reflections off"], fields: ["post.reflections"], overlaps: true },
    { label: "volumetrics off", commands: ["quality postprocessing volumetricLighting off"], fields: ["post.volumetricLighting"], overlaps: true },
    // Every effect that reads the geometry pass, so the pass itself goes too.
    {
      label: "geometry effects off",
      commands: [
        "quality postprocessing ambientOcclusion off", "quality postprocessing reflections off",
        "quality postprocessing volumetricLighting off", "quality shadows screen off",
      ],
      fields: GEOMETRY_EFFECT_FIELDS, overlaps: true,
    },
    { label: "post off", commands: ["postprocessing off"], restore: [`postprocessing ${state.postProcessing ? "on" : "off"}`], fields: ["post.enabled"] },
    { label: "MSAA off", commands: ["quality postprocessing antialiasing off"], fields: ANTI_ALIASING_FIELDS },
    {
      label: `occlusion ${state.occlusion ? "off" : "on"}`, commands: [`quality geometry occlusion ${state.occlusion ? "off" : "on"}`],
      fields: ["geometry.occlusion"],
    },
    // Engine-wide and outside `quality`: back to the session's own mode.
    {
      label: "frames in flight off", commands: ["framesinflight off"], restore: [`framesinflight ${state.framesInFlight}`],
      fields: ["presentation.framesInFlight"],
    },
    { label: "resolution 0.5", commands: ["quality resolution scale 0.5"], fields: ["resolution.scale"], overlaps: true },
  ];
}

/** A Profile's plan: the main scene's own camera, every step between two baselines. */
export function featureTestProfilePlan(state: FeatureTestProfileState): FeatureTestBreakdownPlan {
  return { views: [{ steps: featureTestProfileSteps(state) }] };
}

/** The Profile step a sample measured, by its label (either occlusion step); undefined for baselines and warm-up windows. */
export function profileStep(label: string): FeatureTestBreakdownStep | undefined {
  const on: FeatureTestProfileState = { occlusion: true, framesInFlight: 2, postProcessing: true, captures: true };
  return featureTestProfileSteps(on).find((step) => step.label === label)
    ?? featureTestProfileSteps({ ...on, occlusion: false }).find((step) => step.label === label);
}

/** A camera a Breakdown measures from: `enter` switches to it before its first baseline, and it stays until the next view's. */
export interface FeatureTestBreakdownView {
  /** Prefixes the view's labels; none for the scene's own camera. */
  name?: string;
  enter?: readonly string[];
  steps: readonly FeatureTestBreakdownStep[];
}

/** What a Breakdown measures in one scene. */
export interface FeatureTestBreakdownPlan {
  views: readonly FeatureTestBreakdownView[];
}

const OCCLUSION_STEPS: Readonly<Record<Exclude<FeatureTestBreakdownMethod, "water">, FeatureTestBreakdownStep>> = {
  "add-one": { label: "occlusion on", commands: ["quality geometry occlusion on"], fields: ["geometry.occlusion"] },
  "remove-one": { label: "occlusion off", commands: ["quality geometry occlusion off"], fields: ["geometry.occlusion"] },
};

/**
 * FT_Occlusion (`lib/feature-test/occlusion.ts`): Occlusion Culling against baselines that hold the other value (off in
 * the add-one base, on at Medium), from the street (the scene's main camera, `Camera`) and from a doorway of the rooms
 * (`Rooms Camera`), each possessed by name.
 */
function occlusionPlan(method: Exclude<FeatureTestBreakdownMethod, "water">): FeatureTestBreakdownPlan {
  const step = OCCLUSION_STEPS[method];
  return {
    views: [{ steps: [step] }, { name: "rooms", enter: ['possess "Rooms Camera"'], steps: [step] }],
  };
}

/**
 * A scene's Breakdown plan: a Water Breakdown measures its water steps in any scene; otherwise FT_Occlusion measures
 * occlusion culling from two cameras (on either method's base), every other scene the method's feature steps.
 */
export function featureTestBreakdownPlan(
  sceneName: string, method: FeatureTestBreakdownMethod = FEATURE_TEST_BREAKDOWN_DEFAULT_METHOD,
): FeatureTestBreakdownPlan {
  if (method === "water") return { views: [{ steps: FEATURE_TEST_BREAKDOWN_WATER_STEPS }] };
  if (sceneName === "FT_Occlusion") return occlusionPlan(method);
  return { views: [{ steps: method === "add-one" ? FEATURE_TEST_BREAKDOWN_ADD_ONE_STEPS : FEATURE_TEST_BREAKDOWN_STEPS }] };
}

/** A step in a Breakdown's run order, its label prefixed with its view's name. */
export interface FeatureTestBreakdownSequenceStep extends FeatureTestBreakdownStep {
  view?: string;
}

/**
 * The order a Breakdown measures in: per view, a baseline before every step and one after the last (A B A C A …), so
 * each step is compared with the two baselines immediately around it and slow drift (thermal throttling, background
 * work) cancels. A view's first baseline runs its `enter` commands. A baseline right after a skipped step's is not
 * measured again (`benchmarkProfiles`).
 */
export function breakdownSequence(
  views: readonly FeatureTestBreakdownView[] = featureTestBreakdownPlan("FT_World").views,
): FeatureTestBreakdownSequenceStep[] {
  const sequence: FeatureTestBreakdownSequenceStep[] = [];
  for (const view of views) {
    const prefix = view.name ? `${view.name} ` : "";
    const tag = view.name ? { view: view.name } : {};
    const baseline = (n: number): FeatureTestBreakdownSequenceStep => ({
      label: `${prefix}baseline ${n}`, commands: n === 1 ? view.enter ?? [] : [], baseline: true, ...tag,
    });
    view.steps.forEach((step, index) => sequence.push(baseline(index + 1), { ...step, label: `${prefix}${step.label}`, ...tag }));
    sequence.push(baseline(view.steps.length + 1));
  }
  return sequence;
}

/** The step a Breakdown sample of `sceneName` measured, by its label; undefined for warm-up windows and unknown labels. */
export function breakdownStep(
  sceneName: string, label: string, method: FeatureTestBreakdownMethod = FEATURE_TEST_BREAKDOWN_DEFAULT_METHOD,
): FeatureTestBreakdownSequenceStep | undefined {
  return breakdownSequence(featureTestBreakdownPlan(sceneName, method).views).find((step) => step.label === label);
}

/**
 * Why a Breakdown step is skipped: its fingerprint `fields` hold the same values with the step applied (`settings`)
 * as at the baseline before it (`reference`), so measuring it would compare the baseline with itself. Null when it
 * changes one, or when it names no fields or either fingerprint is missing.
 */
export function breakdownSkip(
  fields: readonly string[] | undefined,
  reference: Readonly<Record<string, string>> | undefined,
  settings: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!fields?.length || !reference || !settings) return null;
  if (fields.some((field) => reference[field] !== settings[field])) return null;
  return `already ${fields.map((field) => `${field} ${settings[field] ?? "-"}`).join(", ")}`;
}

/** Whether a sample is a Breakdown baseline (never a warm-up window). */
export function isBreakdownBaseline(sample: FeatureTestBenchmarkSample): boolean {
  return !sample.warmup && sample.baseline === true;
}

/**
 * What a Breakdown compares: the median GPU-busy time per frame (`gpuBusy`, from fences, unaffected by display pacing)
 * when both sides measured it, else the mean frame interval.
 */
function breakdownValue(sample: FeatureTestBenchmarkSample, gpu: boolean): number | null {
  return gpu ? sample.gpuBusy?.medianMs ?? null : meanFrameMs(sample.frames);
}

/**
 * A sample's mean frame interval: the window over its frames. The median snaps to a multiple of the display's refresh
 * interval (a vsync-paced frame lasts 16.7, 33.3 or 50 ms, nothing between), so a few frames moving between two of
 * them jump it by a whole interval; the mean moves in proportion.
 */
export function meanFrameMs(frames: FrameStats | null): number | null {
  return frames?.meanMs ?? null;
}

/** A change against baselines: in ms, and as a share of them. */
export interface BaselineDelta {
  ms: number;
  percent: number;
}

/**
 * A sample's change in `value` against the baselines of its view around it (the mean of the nearest measured before
 * and after it), or null when it or they are unmeasured. A baseline's change is against its view's first baseline:
 * its drift. Warm-up windows have none and are never references.
 */
function deltaAroundBaselines(
  samples: readonly FeatureTestBenchmarkSample[],
  sample: FeatureTestBenchmarkSample,
  value: (entry: FeatureTestBenchmarkSample) => number | null,
): BaselineDelta | null {
  const index = samples.indexOf(sample);
  const own = index < 0 || sample.warmup ? null : value(sample);
  if (own === null) return null;
  const measured = (entry: FeatureTestBenchmarkSample) => isBreakdownBaseline(entry) && entry.view === sample.view && value(entry) !== null;
  const around = (isBreakdownBaseline(sample)
    ? [samples.find(measured)]
    : [samples.slice(0, index).reverse().find(measured), samples.slice(index + 1).find(measured)])
    .filter((entry): entry is FeatureTestBenchmarkSample => entry !== undefined);
  if (!around.length) return null;
  const base = around.reduce((total, entry) => total + value(entry)!, 0) / around.length;
  const ms = own - base;
  return { ms, percent: (ms / base) * 100 };
}

/**
 * A Breakdown step's change against the baselines of its view around it (`deltaAroundBaselines`): in median GPU-busy
 * time per frame when the step and those baselines measured it (`basis: "gpu"`), else in mean frame interval
 * (`"frame"`).
 */
export function breakdownDelta(
  samples: readonly FeatureTestBenchmarkSample[],
  sample: FeatureTestBenchmarkSample,
): (BaselineDelta & { basis: "gpu" | "frame" }) | null {
  for (const gpu of [true, false]) {
    const delta = deltaAroundBaselines(samples, sample, (entry) => breakdownValue(entry, gpu));
    if (delta) return { ...delta, basis: gpu ? "gpu" : "frame" };
  }
  return null;
}

/** A Profile row's change against the baselines around it, in mean frame time and in median CPU frame cost. */
export function profileDelta(
  samples: readonly FeatureTestBenchmarkSample[],
  sample: FeatureTestBenchmarkSample,
): { frame: BaselineDelta | null; cpu: BaselineDelta | null } {
  return {
    frame: deltaAroundBaselines(samples, sample, (entry) => meanFrameMs(entry.frames)),
    cpu: deltaAroundBaselines(samples, sample, (entry) => entry.cpuMs),
  };
}

/** A Profile's measured steps by frame-time saving, the largest first (a step that cost time last); unmeasured ones left out. */
export function profileRanking(
  samples: readonly FeatureTestBenchmarkSample[],
): { label: string; frame: BaselineDelta; cpu: BaselineDelta | null; overlaps: boolean }[] {
  return samples.flatMap((sample) => {
    if (sample.warmup || sample.skipped || isBreakdownBaseline(sample)) return [];
    const { frame, cpu } = profileDelta(samples, sample);
    return frame ? [{ label: sample.label, frame, cpu, overlaps: profileStep(sample.label)?.overlaps === true }] : [];
  }).sort((a, b) => a.frame.ms - b.frame.ms);
}

/**
 * The frame-time savings of a Profile's steps that overlap no other (`overlaps`), summed, against the first baseline's
 * mean frame time: what the measured features explain of the frame. Null without a measured first baseline.
 */
export function profileSavings(samples: readonly FeatureTestBenchmarkSample[]): { savingsMs: number; frameMs: number } | null {
  const frameMs = meanFrameMs(samples.find(isBreakdownBaseline)?.frames ?? null);
  if (frameMs === null) return null;
  const savingsMs = profileRanking(samples).reduce((total, entry) => entry.overlaps || entry.frame.ms >= 0 ? total : total - entry.frame.ms, 0);
  return { savingsMs, frameMs };
}

/**
 * Whether a remove-one Breakdown's changes add up, per view (none for add-one, whose changes are costs on a base): the savings of its steps that overlap no other step's
 * (`overlaps`), summed in the view's first baseline's basis (GPU-busy median where measured, else mean frame time),
 * against that baseline. A sum past it is NON-ADDITIVE: removing features saved more than the whole frame cost, as
 * when the GPU is saturated and frames queue behind it.
 */
export function breakdownAdditivity(
  sceneName: string,
  samples: readonly FeatureTestBenchmarkSample[],
  method: FeatureTestBreakdownMethod = FEATURE_TEST_BREAKDOWN_DEFAULT_METHOD,
): { view: string | undefined; savingsMs: number; baselineMs: number; basis: "gpu" | "frame"; nonAdditive: boolean }[] {
  if (method === "add-one") return [];
  const views = [...new Set(samples.filter(isBreakdownBaseline).map((sample) => sample.view))];
  return views.flatMap((view) => {
    const first = samples.find((sample) => isBreakdownBaseline(sample) && sample.view === view)!;
    const gpu = breakdownValue(first, true) !== null;
    const baselineMs = breakdownValue(first, gpu);
    if (baselineMs === null) return [];
    const basis = gpu ? "gpu" as const : "frame" as const;
    let savingsMs = 0;
    for (const sample of samples) {
      if (sample.warmup || isBreakdownBaseline(sample) || sample.view !== view) continue;
      if (breakdownStep(sceneName, sample.label, method)?.overlaps) continue;
      const delta = breakdownDelta(samples, sample);
      if (delta?.basis === basis && delta.ms < 0) savingsMs -= delta.ms;
    }
    return [{ view, savingsMs, baselineMs, basis, nonAdditive: savingsMs > baselineMs }];
  });
}

/**
 * An add-one Breakdown's baselines past `ADD_ONE_CAP_MS` (GPU-busy median where measured, else mean frame time): the
 * base nears the GPU's cap, where it may change speed, so the run is OVER CAP.
 */
export function breakdownOverCap(
  samples: readonly FeatureTestBenchmarkSample[],
): { label: string; ms: number; basis: "gpu" | "frame" }[] {
  return samples.flatMap((sample) => {
    if (!isBreakdownBaseline(sample)) return [];
    const gpu = breakdownValue(sample, true) !== null;
    const ms = breakdownValue(sample, gpu);
    return ms !== null && ms > ADD_ONE_CAP_MS ? [{ label: sample.label, ms, basis: gpu ? "gpu" as const : "frame" as const }] : [];
  });
}

/**
 * A Breakdown's warm-up drift: its first warm-up window against the last (the steady one the steps start from), in
 * GPU-busy median when both measured it, else mean frame time; null without two measured windows. A large drift shows
 * the GPU changed speed while warming up.
 */
export function breakdownWarmupDrift(
  samples: readonly FeatureTestBenchmarkSample[],
): { firstMs: number; steadyMs: number; percent: number; windows: number; basis: "gpu" | "frame" } | null {
  const windows = samples.filter((sample) => sample.warmup);
  const first = windows[0];
  const steady = windows.at(-1);
  if (!first || !steady || first === steady) return null;
  for (const gpu of [true, false]) {
    const firstMs = breakdownValue(first, gpu);
    const steadyMs = breakdownValue(steady, gpu);
    if (firstMs === null || steadyMs === null) continue;
    return { firstMs, steadyMs, percent: ((steadyMs - firstMs) / firstMs) * 100, windows: windows.length, basis: gpu ? "gpu" : "frame" };
  }
  return null;
}

/** Above this share of baseline frames lasting four or more display intervals, a Breakdown is SATURATED. */
export const SATURATED_SHARE = 0.5;

/**
 * The share of a Breakdown's baseline frames that lasted four or more display intervals (weighted by frame count), or
 * null when no baseline recorded its pacing. Past `SATURATED_SHARE` the GPU is saturated: frames queue behind it, so a
 * removed feature's saving is not its own cost.
 */
export function breakdownSaturation(samples: readonly FeatureTestBenchmarkSample[]): number | null {
  let frames = 0;
  let saturated = 0;
  for (const sample of samples) {
    if (!isBreakdownBaseline(sample) || !sample.frames) continue;
    frames += sample.frames.frames;
    saturated += sample.frames.vsync[3] * sample.frames.frames;
  }
  return frames > 0 ? saturated / frames : null;
}

/**
 * The live preserveDrawingBuffer of the first of `scenes` that measured a Breakdown baseline (`presentation.preserve`
 * in its settings fingerprint): "true", "false", "n/a" on WebGPU, or undefined when none recorded it.
 */
export function livePreserve(scenes: readonly FeatureTestCheckSceneResult[]): string | undefined {
  for (const scene of scenes) {
    const value = scene.play.benchmark.find((sample) => isBreakdownBaseline(sample) && sample.settings)?.settings?.["presentation.preserve"];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A Breakdown that starts within this long of the previous check's end runs on a warm device. */
export const WARM_DEVICE_MS = 10 * 60_000;

/** Whole minutes since the previous check ended, when it ended within `WARM_DEVICE_MS` before `startedAt`; else null. */
export function warmDeviceMinutes(startedAt: number, previousEndedAt: number | null): number | null {
  if (previousEndedAt === null) return null;
  const elapsed = startedAt - previousEndedAt;
  return elapsed >= 0 && elapsed < WARM_DEVICE_MS ? Math.floor(elapsed / 60_000) : null;
}

/** The display interval a Breakdown's 60 fps cap paces frames to. */
export const VSYNC_MS = 1000 / 60;

/**
 * What limits a sample's frames: `vsync` when the mean frame interval is within 15% of the 60 Hz interval (the cap,
 * not the device), `gpu` when it is more than half again the CPU frame cost (the CPU waits on the GPU), otherwise
 * `cpu`; null without frames or CPU cost.
 */
export function frameBound(frames: FrameStats | null, cpuMs: number | null): "vsync" | "gpu" | "cpu" | null {
  const mean = meanFrameMs(frames);
  if (mean === null || cpuMs === null) return null;
  if (mean <= VSYNC_MS * 1.15) return "vsync";
  return mean > cpuMs * 1.5 ? "gpu" : "cpu";
}

/** Render-settings fingerprint fields that differ between two snapshots, as `field=value` of `after`. */
export function settingsChanges(
  before: Readonly<Record<string, string>> | undefined,
  after: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!before || !after) return [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter((key) => before[key] !== after[key]).map((key) => `${key}=${after[key] ?? "-"}`);
}

/** Above any display refresh, so a Benchmark measures the device rather than the project frame cap. */
const BENCHMARK_FRAME_CAP = 240;
/**
 * A Breakdown samples at the normal 60 fps cap. iOS Safari paces requestAnimationFrame to the display, so a lifted cap
 * gains no frames there; it only lets submitted frames queue behind a busy GPU, which made frames slower than capped
 * Play and drift during the run.
 */
const BREAKDOWN_FRAME_CAP = 60;

export interface FeatureTestBenchmarkSample {
  label: string;
  frames: FrameStats | null;
  runtimeFps: number | null;
  /** Median CPU and GPU frame cost while sampling; GPU is null where timer queries are unavailable. */
  cpuMs: number | null;
  gpuMs: number | null;
  /** Median draw calls per frame while sampling, or the last frame's where the counters were not read. */
  drawCalls: number;
  /** The per-frame counters while sampling; `draws` is absent, and `cpu` and `gpu` null, where they were not read. */
  draws?: CounterStats;
  cpu?: CounterStats | null;
  gpu?: CounterStats | null;
  resolution: string | null;
  failed: string[];
  /** Whether a Breakdown sample is a baseline; absent outside a Breakdown. */
  baseline?: boolean;
  /** A Breakdown warm-up window at the baseline, before the steps (never a reference). */
  warmup?: boolean;
  /** The Breakdown view (`FeatureTestBreakdownView.name`) the sample was measured from; absent for the scene's own camera. */
  view?: string;
  /**
   * Occlusion culling while sampled (`stat draws`' occlusion row), the median of each: meshes tested and culled,
   * occluder triangles rasterised and the culling's ms; absent while the view did not cull.
   */
  occlusion?: { tested: number; culled: number; triangles: number; ms: number };
  /** GPU-busy time per frame from fences while sampled (`gpubusy`); absent where unmeasured. */
  gpuBusy?: NonNullable<RenderDiagnostics["gpuBusy"]>;
  /** The Engine's GPU backpressure while sampled (`framesinflight`): its mode and the renders it skipped; absent where unmeasured. */
  framesInFlight?: { mode: "off" | 2 | 3; skipped: number };
  /** The step's render-settings fingerprint (`RenderDiagnostics.settings`) while sampled. */
  settings?: Record<string, string>;
  /** A Breakdown step not measured, and why (`breakdownSkip`): it has no frames. */
  skipped?: string;
  /** Shaders first drawn and Effects compiling during the sample (both should be 0), and how long settling took. */
  unsettled?: { firstDraws: number; compiling: number; settleMs: number };
  /** Each pass's median draw calls per frame while sampled (`RenderDiagnostics.drawPasses`); absent where unattributed. */
  drawPasses?: Partial<Record<DrawPass, number>>;
  /** The programs the Engine held as the sample ended (`RenderDiagnostics.programs`); absent on WebGPU. */
  programs?: NonNullable<RenderDiagnostics["programs"]>;
  /**
   * Frames the view drew and held while sampled, over `ms` of the check's clock, and why it held them
   * (`RenderDiagnostics.presentation.heldReasons`); absent where the view reports no counts.
   */
  presentation?: SampledPresentation;
  /** The world renderer's work while sampled (`RenderDiagnostics.rendererWork`); absent where the view reports none. */
  work?: SampledRendererWork;
  /** The native host's memory counters as the sample ended (`FeatureTestCheckDeps.hostMemory`); absent where none. */
  memory?: HostMemory;
}

/** The world renderer's work over a sample window: how much each `RenderDiagnostics.rendererWork` counter grew. */
export type SampledRendererWork = NonNullable<RenderDiagnostics["rendererWork"]>;

/** What the view presented over a sample window: frames drawn and held, the window's length and the holds by reason. */
export interface SampledPresentation {
  drawn: number;
  held: number;
  ms: number;
  heldReasons: Record<string, number>;
}

/** What a Profile found besides its rows. */
export interface FeatureTestProfileResult {
  /** The scene's instance pool when the warm-up ended (`RenderDiagnostics.instancePool`); null where unreported. */
  instancePool: RenderDiagnostics["instancePool"] | null;
  /**
   * Settings fingerprint fields that differ, once everything was restored, from before the first step (`field=value`
   * as restored); null when not checked (cancelled, or no fingerprint).
   */
  endChanges: string[] | null;
  /**
   * The scene's own held frames over the warm-up windows (`profileHoldRate`): per second and as a share of the view's
   * attempts. Each step waits against it (`PROFILE_HOLD_MARGIN`). Null where the view reports no counts.
   */
  holdRate: ProfileHoldRate | null;
}

/** How often a view held frames: per second, and as a share of its attempts (drawn plus held). */
export interface ProfileHoldRate {
  heldPerSecond: number;
  share: number;
}

/**
 * A per-frame counter (draw calls, CPU or GPU frame cost) over a sample window, read every half second. One frame's
 * value is not representative: a pass that draws on alternate frames (a static view's planar reflection) moves the draw
 * count by its whole draw count.
 */
export interface CounterStats {
  median: number;
  min: number;
  max: number;
  samples: number;
}

/** What the Play view presented while it was measured. */
export interface PlayPresentation {
  /**
   * Frames the view drew, held (kept its last image, waiting for shaders or settings) and skipped (`framesinflight`)
   * while its frames were sampled, and the holds by reason (`RenderDiagnostics.presentation.heldReasons`); null where
   * the view reports no counts.
   */
  frames: { drawn: number; held: number; skipped: number; heldReasons: Record<string, number> } | null;
  /** Graphics context losses since Play started. */
  contextLosses: number;
  /** Each image sample's near-black share (`PresentedImageSample.blackShare`), oldest first; null where no frame was presented to sample. */
  imageBlack: Array<number | null>;
}

/** Play's per-frame counters while it was sampled. */
export interface PlayCounters {
  draws: CounterStats | null;
  cpuMs: CounterStats | null;
  gpuMs: CounterStats | null;
  /** Each pass's median draw calls per frame while sampled (`RenderDiagnostics.drawPasses`); absent where unattributed. */
  drawPasses?: Partial<Record<DrawPass, number>> | null;
  /**
   * A frame's CPU time with its draws, clears and uniform uploads turned into no-ops (`PlayProbe.stubWebGlDraws`),
   * sampled right after `cpuMs`: what the engine's own JavaScript and state setting cost, so the rest of `cpuMs` is
   * what the draws cost on this thread. Absent or null where the view cannot be stubbed (WebGPU).
   */
  cpuMsWithoutDraws?: CounterStats | null;
}

export interface FrameStats {
  frames: number;
  durationMs: number;
  fps: number;
  /** Median frame interval. */
  medianMs: number;
  /** Mean frame interval (durationMs / frames). */
  meanMs: number;
  /** Shares of frames lasting about 1, 2, 3 and 4 or more 60 Hz intervals. */
  vsync: [number, number, number, number];
  p95Ms: number;
  maxMs: number;
  /** Frame intervals longer than 100 ms. */
  stalls: number;
}

export interface FeatureTestCheckCommandResult {
  line: string;
  success: boolean;
  output: string;
  ms: number;
}

export interface FeatureTestCheckSceneResult {
  name: string;
  path: string;
  /** The Breakdown pass (1 or 2 of its preserveDrawingBuffer A/B) the scene was measured in; absent for other modes. */
  pass?: number;
  editor: {
    status: "ready" | "failed" | "timeout" | "not-opened";
    ms: number;
    phase: string | null;
    frames: FrameStats | null;
    /** The viewport's load failure, one line per message, frame and cause. */
    error: string[] | null;
    gpu: ReturnType<ViewportProbe["gpu"]>;
  };
  play: {
    /** `starting` while the check waits for Play to load: what a run cancelled there reports, with `phase`. */
    status: "loaded" | "timeout" | "closed" | "starting" | "not-started" | "skipped";
    ms: number;
    /** Where Play's load stood when it timed out or the run was cancelled (`playStartState`). */
    phase: string | null;
    frames: FrameStats | null;
    runtimeFps: number | null;
    snapshot: ReturnType<PlayProbe["snapshot"]> | null;
    /** Play's per-frame counters while it was sampled; absent when Play did not load. */
    counters?: PlayCounters | null;
    /** What Play presented while it was measured: frames drawn, held and skipped, context losses and image samples. */
    presentation: PlayPresentation | null;
    /** Shaders first drawn after the scene presented, read when its commands finished (WebGL2 only). */
    firstDraws: NonNullable<RenderDiagnostics["firstDraws"]> | null;
    /**
     * The same, read before a Benchmark's, Breakdown's or Profile's sweep began: what ordinary Play first drew after
     * its load. `firstDraws` then also counts what each of the sweep's quality changes first drew. Absent otherwise.
     */
    firstDrawsBeforeSweep?: NonNullable<RenderDiagnostics["firstDraws"]> | null;
    /**
     * The world renderer's work while Play was sampled, and the frames the view drew then; absent where the view
     * reports neither.
     */
    work?: { drawn: number; work: SampledRendererWork } | null;
    commands: FeatureTestCheckCommandResult[];
    benchmark: FeatureTestBenchmarkSample[];
    /** A Profile's instance pool and end-of-run restore check; absent for other modes. */
    profile?: FeatureTestProfileResult;
    logs: Array<{ severity: string; message: string }>;
  };
  session: {
    diagnostics: PlaySessionResult["diagnostics"];
    droppedDiagnostics: number;
    runtimeMode: PlaySessionResult["runtimeMode"] | null;
    textures: { before: number; after: number | null; leak: boolean; quarantined: boolean } | null;
  } | null;
  passed: boolean;
  problems: string[];
}

/**
 * A page of the app that stopped without closing (a freeze, a crash, a force close), as its stored session trail left
 * it: with or without a check running, so an ordinary Play session that froze is told by the next report.
 */
export interface FeatureTestStoppedSession {
  /** When the page last renewed its trail (`Date.now()`): at its last mark, or within seconds of stopping. */
  lastAliveAt: number;
  /** The stages it passed through last, oldest first. */
  marks: { at: number; stage: string }[];
}

/** What the editor held at one moment of a check: shader programs, textures and memory. */
export interface FeatureTestCheckResources {
  /** Milliseconds since the check started. */
  atMs: number;
  step: string;
  /** Babylon Effects (shader programs) every Engine holds, and how many of them are still compiling. */
  effects: number;
  compiling: number;
  /**
   * Frames the Play view drew and held (kept its last image, waiting for shaders or settings), and the graphics
   * context losses it saw, since Play started.
   */
  playFrames: { drawn: number; held: number; contextLosses: number } | null;
  textures: number;
  /** Estimated GPU bytes of those textures, render targets included (`estimateTextureMemory`). */
  textureBytes: number;
  /** Where the browser reports them: the JS heap (Chromium) and the native shell's footprint. */
  jsHeapBytes: number | null;
  appFootprintBytes: number | null;
  /** Where the native host reports them: the device's free and inactive memory, and the app's headroom (`HostMemory`). */
  deviceAvailableBytes: number | null;
  appAvailableBytes: number | null;
}

/**
 * Memory the native host reports (iOS): the device's free and inactive memory, which also falls as the web content
 * and GPU processes grow (the app cannot read theirs), and how much more the app process may allocate.
 */
export interface HostMemory {
  deviceAvailableBytes: number | null;
  appAvailableBytes: number | null;
}

export interface FeatureTestCheckReport {
  mode: FeatureTestCheckMode;
  startedAt: number;
  durationMs: number;
  cancelled: boolean;
  scenes: FeatureTestCheckSceneResult[];
  pageErrors: string[];
  /** A check the app stopped during (a crash or reload): its last step and resource samples, oldest first. */
  unfinished?: { step: string; resources: FeatureTestCheckResources[] };
  /** Pages that stopped without closing since the last report told of them, oldest first (the session trail). */
  stoppedSessions?: FeatureTestStoppedSession[];
  /** A Breakdown's measurement context; absent for other modes. */
  breakdown?: FeatureTestBreakdownInfo;
}

/** What a Breakdown measured under: its tier, the device's warmth, and its preserveDrawingBuffer A/B. */
export interface FeatureTestBreakdownInfo {
  /** How each feature was measured; its base names what every scene's baselines ran. */
  method: FeatureTestBreakdownMethod;
  /** The base's label (`FEATURE_TEST_BREAKDOWN_BASES[method].label`). */
  tier: string;
  /** Whether the preserveDrawingBuffer A/B was asked for (the Check dialog's checkbox, off by default): one pass without. */
  ab: boolean;
  /** Whole minutes since the previous check ended, when that was within `WARM_DEVICE_MS` of the Breakdown's start. */
  warmMinutes: number | null;
  /**
   * Each pass of the A/B in order, with the stored preserveDrawingBuffer setting it ran with; the live context
   * attribute is in each scene's samples (`presentation.preserve`). Scenes name their pass (`pass`, 1-based).
   */
  passes: { preserveDrawingBuffer: boolean }[];
  /** How the A/B ended when not as planned, and when the restored setting applies. */
  notes: string[];
}

export interface FeatureTestCheckDeps {
  /** Opens the scene document; resolves once the editor accepted the request. */
  openScene: (path: string) => Promise<void>;
  activeDocumentId: () => string | null;
  viewport: (documentId: string) => ViewportProbe | null;
  /** Starts Play from the active scene without the unsaved-changes prompt. */
  startPlay: () => Promise<void>;
  play: () => PlayProbe | null;
  /** True when no game session is preparing, running or stopping. */
  sessionIdle: () => boolean;
  /** True while an Engine's graphics context is lost and not yet restored; absent where unknown. */
  renderingContextLost?: () => boolean;
  onSessionClosed: (listener: (result: PlaySessionResult) => void) => () => void;
  sampleFrames: (durationMs: number, signal: AbortSignal) => Promise<FrameStats | null>;
  /** Shader programs still compiling across every Engine; absent where unknown. */
  compiling?: () => number;
  /** The native host's memory counters; absent, or null, where it reports none. */
  hostMemory?: () => Promise<HostMemory | null>;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onProgress?: (message: string) => void;
}

export interface FeatureTestCheckTimeouts {
  sceneOpenMs: number;
  playLoadMs: number;
  playCloseMs: number;
  commandMs: number;
  releaseMs: number;
  /** Quiet time, with no shader first drawn and none compiling, a profile waits for before it samples. */
  profileSettleMs: number;
  /**
   * Most a profile waits for the view to draw again without held frames (a Profile: within its hold margin), before the
   * settle; past it, the sweep stops (a Profile's only when the view stopped drawing). Benchmark and Breakdown also
   * bound the settle by it.
   */
  profileCompileMs: number;
  /** A Profile's bound on the settle (`profileSettleMs` of quiet), in place of `profileCompileMs`. */
  profileSettleBoundMs: number;
  /**
   * Most a Profile's first warm-up window waits for the view to draw within `PROFILE_HOLD_MARGIN` of no holds, before it
   * knows the scene's own hold rate; past it, a view that still draws is sampled as it draws.
   */
  profileFirstWaitMs: number;
  editorSampleMs: number;
  playSampleMs: number;
  /** A Breakdown's warm-up window: it ends once two consecutive windows differ by under 3%. */
  breakdownWarmupWindowMs: number;
  /** Most a Breakdown warms up before its first step, stable or not. */
  breakdownWarmupMs: number;
  /** A Profile's warm-up window; it warms up for at most `PROFILE_WARMUP_WINDOWS` of them. */
  profileWarmupWindowMs: number;
}

const DEFAULT_FEATURE_TEST_CHECK_TIMEOUTS: FeatureTestCheckTimeouts = {
  sceneOpenMs: 120_000,
  playLoadMs: 120_000,
  playCloseMs: 30_000,
  commandMs: 60_000,
  releaseMs: 10_000,
  profileSettleMs: 3_000,
  profileCompileMs: 90_000,
  profileSettleBoundMs: 20_000,
  profileFirstWaitMs: 10_000,
  editorSampleMs: 3_000,
  playSampleMs: 5_000,
  breakdownWarmupWindowMs: 10_000,
  breakdownWarmupMs: 90_000,
  profileWarmupWindowMs: 5_000,
};

/** A Profile warms up for at most this many windows (fewer when the first two agree within 3%): a short run on a tablet. */
export const PROFILE_WARMUP_WINDOWS = 2;

/** Consecutive warm-up windows within this share of each other end a Breakdown's warm-up. */
const WARMUP_STABLE = 0.03;

const POLL_MS = 250;

/** Frame statistics from rAF intervals in milliseconds. */
export function frameStats(intervals: readonly number[]): FrameStats | null {
  if (!intervals.length) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const durationMs = intervals.reduce((total, value) => total + value, 0);
  return {
    frames: intervals.length,
    durationMs,
    fps: durationMs > 0 ? (intervals.length * 1000) / durationMs : 0,
    medianMs: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    meanMs: durationMs / intervals.length,
    vsync: vsyncShares(intervals),
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: sorted[sorted.length - 1],
    stalls: intervals.filter((value) => value > 100).length,
  };
}

/** Shares of `intervals` lasting about 1, 2, 3 and 4 or more 60 Hz display intervals. */
export function vsyncShares(intervals: readonly number[]): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const interval of intervals) counts[Math.min(3, Math.max(0, Math.round(interval / VSYNC_MS) - 1))] += 1;
  return counts.map((count) => (intervals.length ? count / intervals.length : 0)) as [number, number, number, number];
}

function timeout<T>(promise: Promise<T>, ms: number, deps: FeatureTestCheckDeps, signal: AbortSignal): Promise<T | "timeout"> {
  return Promise.race([promise, deps.sleep(ms, signal).then(() => "timeout" as const)]);
}

/** Polls `done` until it returns a value, the deadline passes, or the run is cancelled. */
async function waitFor<T>(deps: FeatureTestCheckDeps, signal: AbortSignal, ms: number, done: () => T | null | undefined): Promise<T | null> {
  const deadline = deps.now() + ms;
  for (;;) {
    signal.throwIfAborted();
    const value = done();
    if (value !== null && value !== undefined) return value;
    if (deps.now() >= deadline) return null;
    await deps.sleep(POLL_MS, signal);
  }
}

/**
 * Walks Feature Test scenes in the editor and in Play and records what a
 * developer needs to debug a device remotely. Never throws for a scene
 * failure; cancellation stops Play and returns the partial report.
 */
export async function runFeatureTestCheck(options: {
  mode: FeatureTestCheckMode;
  /** Scene paths to check; Quick passes the current scene. */
  scenes: ReadonlyArray<{ name: string; path: string }>;
  deps: FeatureTestCheckDeps;
  signal: AbortSignal;
  timeouts?: Partial<FeatureTestCheckTimeouts>;
  pageErrors?: () => string[];
  /** Each progress step with the report so far, which a crash would otherwise lose. */
  onStep?: (step: string, report: FeatureTestCheckReport) => void;
  /** A Breakdown's context, kept in the report; its scenes belong to the last of its `passes`. */
  breakdown?: FeatureTestBreakdownInfo;
}): Promise<FeatureTestCheckReport> {
  const { signal, mode, breakdown } = options;
  const limits = { ...DEFAULT_FEATURE_TEST_CHECK_TIMEOUTS, ...options.timeouts };
  const startedAt = options.deps.now();
  const wallClock = Date.now();
  const scenes: FeatureTestCheckSceneResult[] = [];
  const report = (cancelled: boolean): FeatureTestCheckReport => ({
    mode, startedAt: wallClock, durationMs: options.deps.now() - startedAt, cancelled, scenes, pageErrors: options.pageErrors?.() ?? [],
    ...(breakdown ? { breakdown } : {}),
  });
  const partial = () => report(false);
  const deps: FeatureTestCheckDeps = {
    ...options.deps,
    onProgress: (message) => {
      options.deps.onProgress?.(message);
      options.onStep?.(message, partial());
    },
  };
  let cancelled = false;
  for (const scene of options.scenes) {
    if (signal.aborted) { cancelled = true; break; }
    const result = emptySceneResult(scene);
    if (breakdown?.passes.length) result.pass = breakdown.passes.length;
    scenes.push(result);
    try {
      await checkScene(result, mode, deps, signal, limits, breakdown?.method ?? FEATURE_TEST_BREAKDOWN_DEFAULT_METHOD);
    } catch (error) {
      if (!signal.aborted) throw error;
      cancelled = true;
      result.problems.push("Cancelled while checking this scene.");
      deps.play()?.stop();
      break;
    }
  }
  return report(cancelled);
}

function emptySceneResult(scene: { name: string; path: string }): FeatureTestCheckSceneResult {
  return {
    name: scene.name, path: scene.path,
    editor: { status: "not-opened", ms: 0, phase: null, frames: null, error: null, gpu: null },
    play: {
      status: "not-started", ms: 0, phase: null, frames: null, runtimeFps: null, snapshot: null, presentation: null, firstDraws: null,
      commands: [], benchmark: [], logs: [],
    },
    session: null, passed: false, problems: [],
  };
}

/** Fills `result` in place, so a cancelled run still reports how far the scene got. */
async function checkScene(
  result: FeatureTestCheckSceneResult,
  mode: FeatureTestCheckMode,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
  method: FeatureTestBreakdownMethod,
): Promise<void> {
  const scene = result;
  const documentId = `scene:${scene.path}`;
  deps.onProgress?.(`${scene.name}: opening in the editor`);
  const started = deps.now();
  await deps.openScene(scene.path);
  const opened = await waitFor(deps, signal, limits.sceneOpenMs, () => {
    if (deps.activeDocumentId() !== documentId) return null;
    const viewport = deps.viewport(documentId);
    if (viewport?.failed()) return "failed" as const;
    return viewport?.ready() ? "ready" as const : null;
  });
  result.editor.ms = deps.now() - started;
  const viewport = deps.viewport(documentId);
  result.editor.gpu = viewport?.gpu() ?? null;
  const error = viewport?.error();
  if (error !== undefined && error !== null) result.editor.error = describeError(error);
  if (opened === null) {
    const active = deps.activeDocumentId() === documentId;
    result.editor.status = active ? "timeout" : "not-opened";
    result.editor.phase = deps.viewport(documentId)?.phase() ?? null;
    result.problems.push(active
      ? `Editor viewport did not finish loading in ${seconds(limits.sceneOpenMs)}${result.editor.phase ? ` (stuck at ${result.editor.phase})` : ""}.`
      : "Scene did not open; an unsaved-changes prompt or another dialog may have blocked it.");
    return;
  }
  result.editor.status = opened;
  if (opened === "failed") {
    result.editor.phase = deps.viewport(documentId)?.phase() ?? null;
    result.problems.push(`Editor viewport reported Scene Loading Failed${result.editor.phase ? ` at ${result.editor.phase}` : ""}.`);
    return;
  }
  deps.onProgress?.(`${scene.name}: measuring the editor viewport`);
  result.editor.frames = await deps.sampleFrames(limits.editorSampleMs, signal);

  let attempt = await startPlay(result, deps, signal, limits);
  const lost = attempt.closedEarly ? lostContextLoading(attempt.closedEarly) : null;
  if (attempt.loaded === "closed" && attempt.closedEarly && lost) {
    // A device that dropped the context under memory pressure may load once the context is back: start Play again, once.
    deps.onProgress?.(`${scene.name}: Play lost the rendering context while loading; waiting to start it again`);
    const failedAfter = result.play.ms;
    await timeout(attempt.closedEarly.released, limits.releaseMs, deps, signal);
    await waitFor(deps, signal, limits.playCloseMs, () => deps.sessionIdle() || null);
    const restored = await waitFor(deps, signal, limits.sceneOpenMs, () => {
      if (deps.renderingContextLost?.()) return null;
      const editor = deps.viewport(documentId);
      return !editor || editor.ready() || editor.failed() ? true : null;
    });
    if (restored === null) {
      result.problems.push(`The rendering context was not restored in ${seconds(limits.sceneOpenMs)}, so Play was not started again.`);
    } else {
      result.problems.push(`Play's first load failed after ${seconds(failedAfter)}, so Play was started again: ${sentence(lost)}`);
      attempt = await startPlay(result, deps, signal, limits);
    }
  }
  const { loaded, closed } = attempt;
  const closedEarly = () => attempt.closedEarly;
  const play = deps.play();
  if (loaded === "loaded" && play) {
    result.play.status = "loaded";
    deps.onProgress?.(`${scene.name}: measuring Play`);
    const before = presentationCounts(play);
    const workBefore = play.snapshot().rendering?.rendererWork;
    const sampled = await sampleWithCounters(play, deps.sampleFrames(limits.playSampleMs, signal), deps, signal);
    result.play.frames = sampled.frames;
    result.play.counters = { draws: sampled.draws, cpuMs: sampled.cpu, gpuMs: sampled.gpu, drawPasses: sampled.drawPasses };
    result.play.runtimeFps = play.runtimeFps();
    result.play.snapshot = play.snapshot();
    const sampledWork = rendererWorkSince(workBefore, result.play.snapshot.rendering?.rendererWork);
    const drawnAfter = presentationCounts(play);
    result.play.work = sampledWork && before && drawnAfter ? { drawn: drawnAfter.drawn - before.drawn, work: sampledWork } : null;
    result.play.presentation = await samplePresentation(play, before, deps, signal);
    result.problems.push(...presentationProblems(result.play.presentation));
    deps.onProgress?.(`${scene.name}: measuring Play without draws`);
    result.play.counters.cpuMsWithoutDraws = await sampleCpuWithoutDraws(play, deps, signal);
    const run = (line: string) => runCommand(play, line, deps, signal, limits);
    if (mode === "benchmark" || mode === "breakdown" || mode === "profile") {
      result.play.firstDrawsBeforeSweep = play.snapshot().rendering?.firstDraws ?? null;
      if (mode === "profile") result.play.profile = { instancePool: null, endChanges: null, holdRate: null };
      await benchmarkProfiles(scene.name, mode, method, play, run, deps, signal, limits, result.play.benchmark, result.play.profile);
      for (const sample of result.play.benchmark) {
        for (const failure of sample.failed) result.problems.push(`${sample.label}: ${failure}`);
      }
    } else {
      for (const line of featureTestCheckCommands(scene.name, mode)) {
        deps.onProgress?.(`${scene.name}: running ${line}`);
        const command = await run(line);
        result.play.commands.push(command);
        if (!command.success) result.problems.push(`Command ${line} failed: ${sentence(command.output || "no output")}`);
      }
    }
    result.play.firstDraws = play.snapshot().rendering?.firstDraws ?? null;
  } else if (loaded === "closed") {
    result.play.status = "closed";
    result.problems.push("Play closed before the scene finished loading.");
  } else if (loaded === null) {
    result.play.status = "timeout";
    result.problems.push(`Play did not finish loading in ${seconds(limits.playLoadMs)} (stuck at ${result.play.phase}).`);
  }
  if (play) result.play.logs = play.problemLogs();

  deps.onProgress?.(`${scene.name}: stopping Play`);
  if (!closedEarly()) deps.play()?.stop();
  const session = await timeout(closed, limits.playCloseMs, deps, signal);
  if (session === "timeout") {
    result.problems.push(`Play did not close in ${seconds(limits.playCloseMs)}.`);
  } else {
    const released = await timeout(session.released, limits.releaseMs, deps, signal);
    result.session = {
      diagnostics: session.diagnostics,
      droppedDiagnostics: session.droppedDiagnostics,
      runtimeMode: session.runtimeMode,
      textures: {
        before: session.textureCountBefore,
        after: released === "timeout" ? null : released.textureCountAfter,
        leak: released !== "timeout" && released.textureLeak,
        quarantined: released !== "timeout" && released.quarantined,
      },
    };
    const errors = session.diagnostics.filter((entry) => entry.severity === "error");
    if (errors.length) result.problems.push(`Session report has ${errors.length} error${errors.length === 1 ? "" : "s"}.`);
    if (result.session.textures?.quarantined) result.problems.push("Game resources did not confirm release.");
  }
  await waitFor(deps, signal, limits.playCloseMs, () => deps.sessionIdle() || null);
  result.passed = result.problems.length === 0;
}

/** Where a starting Play stands: its load phase, or why it has not ticked since its first frame. */
export function playStartState(play: PlayProbe | null): string {
  if (!play) return "no Play view yet";
  const phase = play.loadingPhase();
  if (phase) return `${phase.phase} ${Math.round(phase.progress)}%`;
  if (play.tickIndex() > 0) return "running";
  return play.paused() ? "first frame shown, paused before the first tick" : "first frame shown, no tick yet";
}

/** The message of the load failure a lost graphics context caused, when that is how `session` ended. */
function lostContextLoading(session: PlaySessionResult): string | null {
  return session.diagnostics.find((entry) => entry.code === "scene.loading.contextLost")?.message ?? null;
}

interface PlayAttempt {
  loaded: "loaded" | "closed" | null;
  /** The session's close, whenever it comes. */
  closed: Promise<PlaySessionResult>;
  /** Set once the session closed. */
  closedEarly: PlaySessionResult | null;
}

/**
 * Starts Play and waits for its load: the first presented frame and a game tick. While it waits, the status and
 * `result.play` say where the load stands (`playStartState`), so a run cancelled or timed out here reports it.
 */
async function startPlay(
  result: FeatureTestCheckSceneResult,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
): Promise<PlayAttempt> {
  const attempt: PlayAttempt = {
    loaded: null,
    closed: new Promise<PlaySessionResult>((resolve) => {
      const stop = deps.onSessionClosed((session) => { stop(); resolve(session); });
      signal.addEventListener("abort", stop, { once: true });
    }),
    closedEarly: null,
  };
  void attempt.closed.then((session) => { attempt.closedEarly = session; });
  const started = deps.now();
  let shown: string | null = null;
  const track = (state: string) => {
    result.play.ms = deps.now() - started;
    result.play.phase = state;
    if (state === shown) return;
    shown = state;
    deps.onProgress?.(`${result.name}: starting Play (${state})`);
  };
  result.play.status = "starting";
  track("requested");
  await deps.startPlay();
  attempt.loaded = await waitFor(deps, signal, limits.playLoadMs, () => {
    if (attempt.closedEarly) return "closed" as const;
    const play = deps.play();
    if (play && play.loadingPhase() === null && play.tickIndex() > 0) return "loaded" as const;
    track(playStartState(play));
    return null;
  });
  result.play.ms = deps.now() - started;
  if (attempt.loaded !== null) result.play.phase = null;
  return attempt;
}

async function runCommand(
  play: PlayProbe,
  line: string,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
): Promise<FeatureTestCheckCommandResult> {
  const started = deps.now();
  const outcome = await timeout(play.executeConsoleCommand(line), limits.commandMs, deps, signal)
    .catch((error: unknown) => ({ success: false, output: error instanceof Error ? error.message : String(error) }));
  const ms = deps.now() - started;
  return outcome === "timeout"
    ? { line, success: false, output: `No reply in ${seconds(limits.commandMs)}`, ms }
    : { line, success: outcome.success, output: outcome.output, ms };
}

/** Image samples per scene, `PRESENTED_IMAGE_SPACING_MS` apart, after Play's frames are measured. */
const PRESENTED_IMAGE_SAMPLES = 3;
const PRESENTED_IMAGE_SPACING_MS = 1_000;
/** Most one image sample waits for a presented frame. */
const PRESENTED_IMAGE_WAIT_MS = 5_000;
/**
 * An image sample is black when at least this share of it is near-black. Every Feature Test scene shows a lit sky or
 * backdrop, which samples none; a black world under main's HUD still leaves most of the image black.
 */
const BLACK_IMAGE_SHARE = 0.6;

function presentationCounts(play: PlayProbe): {
  drawn: number; held: number; skipped: number; contextLosses: number; heldReasons: Readonly<Record<string, number>>;
} | null {
  const rendering = play.snapshot().rendering;
  const presentation = rendering?.presentation;
  return presentation ? {
    drawn: presentation.drawn, held: presentation.held, skipped: rendering.frameBackpressure?.skipped ?? 0,
    contextLosses: presentation.contextLosses, heldReasons: presentation.heldReasons,
  } : null;
}

/** The native host's memory counters now, or null where it reports neither or the read fails. */
async function readHostMemory(deps: FeatureTestCheckDeps): Promise<HostMemory | null> {
  const memory = await deps.hostMemory?.().catch(() => null);
  return memory && (memory.deviceAvailableBytes !== null || memory.appAvailableBytes !== null) ? memory : null;
}

/** How much each of the world renderer's work counters grew between two `RenderDiagnostics.rendererWork` readings. */
function rendererWorkSince(
  before: SampledRendererWork | undefined, after: SampledRendererWork | undefined,
): SampledRendererWork | null {
  if (!before || !after) return null;
  return {
    graphBuilds: after.graphBuilds - before.graphBuilds,
    shadowAdmissions: after.shadowAdmissions - before.shadowAdmissions,
    shadowAdmissionMs: after.shadowAdmissionMs - before.shadowAdmissionMs,
    strictReadinessChecks: after.strictReadinessChecks - before.strictReadinessChecks,
    readinessProbeMs: after.readinessProbeMs - before.readinessProbeMs,
    outlineReadinessChecks: after.outlineReadinessChecks - before.outlineReadinessChecks,
  };
}

/** The holds each reason added between two `RenderDiagnostics.presentation.heldReasons` readings; reasons that added none left out. */
export function heldReasonsSince(
  before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>,
): Record<string, number> {
  const since: Record<string, number> = {};
  for (const [reason, count] of Object.entries(after)) {
    const added = count - (Object.hasOwn(before, reason) ? before[reason]! : 0);
    if (added > 0) since[reason] = added;
  }
  return since;
}

/** The share of a view's attempts (drawn plus held) it held, or null without an attempt. */
export function heldShare(counts: { drawn: number; held: number }): number | null {
  const attempts = counts.drawn + counts.held;
  return attempts > 0 ? counts.held / attempts : null;
}

/**
 * A Profile's hold rate: the frames its warm-up windows held, per second of their windows and as a share of their
 * attempts; null without counts or attempts.
 */
export function profileHoldRate(samples: readonly FeatureTestBenchmarkSample[]): ProfileHoldRate | null {
  let drawn = 0;
  let held = 0;
  let ms = 0;
  for (const sample of samples) {
    if (!sample.warmup || !sample.presentation) continue;
    drawn += sample.presentation.drawn;
    held += sample.presentation.held;
    ms += sample.presentation.ms;
  }
  const share = heldShare({ drawn, held });
  return share === null || ms <= 0 ? null : { heldPerSecond: (held * 1000) / ms, share };
}

/** The frames presented since `before`, then `PRESENTED_IMAGE_SAMPLES` samples of the image the player sees. */
async function samplePresentation(
  play: PlayProbe, before: ReturnType<typeof presentationCounts>, deps: FeatureTestCheckDeps, signal: AbortSignal,
): Promise<PlayPresentation> {
  const after = presentationCounts(play);
  const imageBlack: Array<number | null> = [];
  for (let index = 0; index < PRESENTED_IMAGE_SAMPLES; index += 1) {
    if (index) await deps.sleep(PRESENTED_IMAGE_SPACING_MS, signal);
    const sample = await timeout(play.samplePresentedImage(), PRESENTED_IMAGE_WAIT_MS, deps, signal);
    imageBlack.push(sample === "timeout" || sample === null ? null : sample.blackShare);
  }
  const last = presentationCounts(play) ?? after;
  return {
    frames: before && after
      ? {
        drawn: after.drawn - before.drawn, held: after.held - before.held, skipped: after.skipped - before.skipped,
        heldReasons: heldReasonsSince(before.heldReasons, after.heldReasons),
      }
      : null,
    contextLosses: last?.contextLosses ?? 0,
    imageBlack,
  };
}

/** A lost graphics context, an image black in most samples, or no presented frame to sample fails the scene. */
function presentationProblems(presentation: PlayPresentation): string[] {
  const problems: string[] = [];
  const losses = presentation.contextLosses;
  if (losses) problems.push(`The graphics context was lost ${losses === 1 ? "once" : `${losses} times`} during Play.`);
  const samples = presentation.imageBlack;
  const black = samples.filter((share) => share !== null && share >= BLACK_IMAGE_SHARE).length;
  if (black * 2 > samples.length) problems.push(`Play image was black in ${black} of ${samples.length} samples.`);
  else if (samples.length && samples.every((share) => share === null)) {
    problems.push(`Play presented no frame to sample in ${seconds(PRESENTED_IMAGE_WAIT_MS)}.`);
  }
  return problems;
}

/** Polls of new draws without a held one before a recompiling profile samples (one second at POLL_MS). */
const STEADY_POLLS = 4;

/** The trailing window over which a Profile reads the view's held share after commands. */
export const PROFILE_HOLD_WINDOW_MS = 2_000;

/**
 * How much more of its attempts than the scene's own hold rate (`ProfileHoldRate.share`, from the warm-up) a Profile's
 * view may hold over `PROFILE_HOLD_WINDOW_MS` and still draw steadily: 15 percentage points (with no rate yet, 15% in
 * all). A step's new shaders or rebuilt targets hold nearly every frame, far past it; a scene's own steady holds stay
 * within it in most windows: at a 23% share and about 20 attempts in 2 s (10 fps), one window's share spreads about 9
 * points, and the wait checks a new window every poll.
 */
export const PROFILE_HOLD_MARGIN = 0.15;

/**
 * How a sweep's wait for the view ended: `steady` (it drew as the rule asks), `holding` (a Profile's view still draws
 * but holds more than its margin allows, sampled as it is) or `stopped` (no frame drawn: the sweep ends).
 */
type DrawWait = { outcome: "steady" | "holding" | "stopped"; share: number | null };

/**
 * Benchmark and Breakdown: waits, bounded by `ms`, until the Play view draws without holding frames
 * (shaders and WebGPU pipelines a profile asked for are ready). True when it
 * did, or when the view reports no presentation counts to watch.
 */
async function viewDrawsSteadily(play: PlayProbe, deps: FeatureTestCheckDeps, signal: AbortSignal, ms: number): Promise<boolean> {
  let last: { drawn: number; held: number } | null = null;
  let steady = 0;
  const done = await waitFor(deps, signal, ms, () => {
    const presentation = play.snapshot().rendering?.presentation;
    if (!presentation) return true;
    steady = last && presentation.held === last.held && presentation.drawn > last.drawn ? steady + 1 : 0;
    last = { drawn: presentation.drawn, held: presentation.held };
    return steady >= STEADY_POLLS ? true : null;
  });
  return done === true;
}

/**
 * A Profile: waits, bounded by `bounds.ms`, until over the last `PROFILE_HOLD_WINDOW_MS` the view drew frames and held
 * at most `bounds.share` of its attempts (`steady`), so a scene that holds frames at a steady rate does not wait for
 * none. Past `bounds.acceptAfterMs` a view that still drew in that window is taken as it is (`holding`); one that drew
 * none by `bounds.ms` has `stopped`. A view without presentation counts is steady. `share` is the last window's.
 */
async function viewDrawsWithinHoldShare(
  play: PlayProbe, deps: FeatureTestCheckDeps, signal: AbortSignal, bounds: { share: number; acceptAfterMs: number; ms: number },
): Promise<DrawWait> {
  const started = deps.now();
  const trail: { at: number; drawn: number; held: number }[] = [];
  let share: number | null = null;
  const outcome = await waitFor(deps, signal, bounds.ms, () => {
    const presentation = play.snapshot().rendering?.presentation;
    if (!presentation) return "steady" as const;
    const now = deps.now();
    trail.push({ at: now, drawn: presentation.drawn, held: presentation.held });
    // The window starts at the newest reading at least a window old.
    while (trail.length > 1 && now - trail[1]!.at >= PROFILE_HOLD_WINDOW_MS) trail.shift();
    const start = trail[0]!;
    if (now - start.at < PROFILE_HOLD_WINDOW_MS) return null;
    const drawn = presentation.drawn - start.drawn;
    share = heldShare({ drawn, held: presentation.held - start.held });
    if (drawn <= 0) return null;
    if (share !== null && share <= bounds.share) return "steady" as const;
    return now - started >= bounds.acceptAfterMs ? "holding" as const : null;
  });
  return { outcome: outcome ?? "stopped", share };
}

/**
 * Waits, bounded by `ms`, until no shader has been first drawn and none compiled for `quietMs`, so a sample measures
 * the step and not the variants it asked for. Shaders first drawn are read from `RenderDiagnostics.firstDraws` (WebGL2
 * only) and compiling Effects from `deps.compiling`; with neither, it waits `quietMs`. Returns how long it waited and
 * whether it went quiet.
 */
async function settleView(
  play: PlayProbe, deps: FeatureTestCheckDeps, signal: AbortSignal, quietMs: number, ms: number,
): Promise<{ quiet: boolean; ms: number }> {
  const started = deps.now();
  let last: number | null = null;
  let quietSince = started;
  const quiet = await waitFor(deps, signal, ms, () => {
    const draws = play.snapshot().rendering?.firstDraws?.draws ?? 0;
    const busy = (deps.compiling?.() ?? 0) > 0 || (last !== null && draws !== last);
    last = draws;
    if (busy) quietSince = deps.now();
    return deps.now() - quietSince >= quietMs ? true : null;
  });
  return { quiet: quiet === true, ms: deps.now() - started };
}

/** A Profile's base: the session's own quality tier, so no commands; `quality reset` alone returns to it. */
const PROFILE_BASE: FeatureTestBreakdownBase = { label: "the session's quality", commands: [] };

/**
 * Sweeps FEATURE_TEST_BENCHMARK_PROFILES (a Benchmark, frame cap lifted), the scene's Breakdown plan (a Breakdown at
 * the normal cap on its method's base) or a Profile's plan (at the session's own tier and frame cap), undoing each
 * Breakdown or Profile step after it, into `samples`, one as each finishes. A Profile then restores the session's
 * quality and checks it; a Benchmark and a Breakdown restore the cap alone, their session ending with the sweep. A step
 * whose fields already hold its values is skipped (`breakdownSkip`), and so is the baseline after it, the one before
 * still being adjacent. A Profile also fills `profile`.
 */
async function benchmarkProfiles(
  sceneName: string,
  mode: "benchmark" | "breakdown" | "profile",
  method: FeatureTestBreakdownMethod,
  play: PlayProbe,
  run: (line: string) => Promise<FeatureTestCheckCommandResult>,
  deps: FeatureTestCheckDeps,
  signal: AbortSignal,
  limits: FeatureTestCheckTimeouts,
  samples: FeatureTestBenchmarkSample[],
  profile?: FeatureTestProfileResult,
): Promise<void> {
  const breakdown = mode === "breakdown";
  // Breakdown and Profile alternate baselines and steps, time the GPU with fences and fingerprint every sample.
  const interleaved = mode !== "benchmark";
  const plan = featureTestBreakdownPlan(sceneName, method);
  const base = breakdown ? FEATURE_TEST_BREAKDOWN_BASES[method] : PROFILE_BASE;
  // A Profile keeps the session's frame cap.
  const cap = mode === "profile" ? undefined : /(\d+)/.exec((await run("framecap")).output)?.[1];
  if (mode !== "profile") await run(`framecap ${breakdown ? BREAKDOWN_FRAME_CAP : BENCHMARK_FRAME_CAP}`);
  // A Profile's plan depends on the session as its warm-up found it.
  let steps: readonly FeatureTestBreakdownSequenceStep[] = mode === "benchmark" ? FEATURE_TEST_BENCHMARK_PROFILES
    : breakdown ? breakdownSequence(plan.views) : [];
  /** Runs `lines`, adding each failure to `failed`. */
  const runAll = async (lines: readonly string[], failed: string[]) => {
    for (const line of lines) {
      const command = await run(line);
      if (!command.success) failed.push(`${line} failed: ${sentence(command.output || "no output")}`);
    }
  };
  const pendingRestore: string[] = [];
  // Failures of the base or of a step's undo, reported on the next sample: the one they would skew.
  const carried: string[] = [];
  /** Back to the base: `quality reset` clears every session override, the base's included. */
  const restore = async () => {
    if (!interleaved) return;
    await run("quality reset");
    await runAll(base.commands, carried);
    await runAll(pendingRestore.splice(0), carried);
  };
  const profileMode = mode === "profile";
  /**
   * Waits for the view to draw after commands, or before a warm-up window. Benchmark and Breakdown: strictly, without a
   * held frame (`viewDrawsSteadily`). A Profile: against the scene's own hold rate from the warm-up windows so far
   * (`viewDrawsWithinHoldShare`, `PROFILE_HOLD_MARGIN`); before the first, a view that draws is sampled after
   * `profileFirstWaitMs`. `note` says when a Profile's view still held more than that allows, against a known rate.
   */
  const waitForDraws = async (): Promise<DrawWait & { note: string | null }> => {
    if (!profileMode) {
      return { outcome: await viewDrawsSteadily(play, deps, signal, limits.profileCompileMs) ? "steady" : "stopped", share: null, note: null };
    }
    const rate = profileHoldRate(samples);
    const allowed = (rate?.share ?? 0) + PROFILE_HOLD_MARGIN;
    const drew = await viewDrawsWithinHoldShare(play, deps, signal, {
      share: allowed, acceptAfterMs: rate ? limits.profileCompileMs : limits.profileFirstWaitMs, ms: limits.profileCompileMs,
    });
    const note = drew.outcome === "holding" && rate && drew.share !== null
      ? `The view still held ${percent(drew.share)} of its frames over the last ${seconds(PROFILE_HOLD_WINDOW_MS)} after ${seconds(limits.profileCompileMs)}, past the ${percent(allowed)} its warm-up allows (${percent(rate.share)} plus ${Math.round(PROFILE_HOLD_MARGIN * 100)} points); these frames include them.`
      : null;
    return { ...drew, note };
  };
  /** Why the sweep ends after a wait in which the view stopped drawing. */
  const stoppedNote = profileMode
    ? `The view drew no frame in the last ${seconds(PROFILE_HOLD_WINDOW_MS)} of ${seconds(limits.profileCompileMs)}; the remaining profiles were skipped.`
    : `The view did not draw steadily within ${seconds(limits.profileCompileMs)}; the remaining profiles were skipped.`;
  // A Profile bounds the wait for quiet shaders more tightly: a tablet's steady scene may never go quiet for long.
  const settleBoundMs = profileMode ? limits.profileSettleBoundMs : limits.profileCompileMs;
  const settle = () => settleView(play, deps, signal, limits.profileSettleMs, settleBoundMs);
  const unsettledNote = (what: string) =>
    `Shaders were still first drawn or compiling after ${seconds(settleBoundMs)}; this ${what}'s frames include them.`;
  // GPU-busy time per frame from fences, which display pacing does not quantise; restarted per sample.
  let gpuBusy = false;
  /** Samples the view as it is now into a sample labelled `label`; `failed` collects what went wrong. */
  const measure = async (label: string, failed: string[], sampleMs: number, settled: { quiet: boolean; ms: number }) => {
    const firstDrawsBefore = play.snapshot().rendering?.firstDraws?.draws ?? 0;
    const skippedBefore = play.snapshot().rendering?.frameBackpressure?.skipped ?? 0;
    if (interleaved) gpuBusy = (await run("gpubusy on")).success;
    const presentedBefore = presentationCounts(play);
    const workBefore = play.snapshot().rendering?.rendererWork;
    const sampleStarted = deps.now();
    const sampled = await sampleWithCounters(play, deps.sampleFrames(sampleMs, signal), deps, signal);
    const presentedAfter = presentationCounts(play);
    const sampleMsTaken = deps.now() - sampleStarted;
    const memory = await readHostMemory(deps);
    const snapshot = play.snapshot();
    const rendering = snapshot.rendering;
    const work = rendererWorkSince(workBefore, rendering?.rendererWork);
    const sample: FeatureTestBenchmarkSample = {
      label,
      frames: sampled.frames,
      runtimeFps: play.runtimeFps(),
      cpuMs: sampled.cpu?.median ?? null,
      gpuMs: sampled.gpu?.median ?? null,
      drawCalls: sampled.draws?.median ?? snapshot.drawCalls,
      draws: sampled.draws ?? undefined,
      cpu: sampled.cpu,
      gpu: sampled.gpu,
      resolution: rendering ? `${rendering.width}x${rendering.height}@${rendering.scalingLevel.toFixed(2)}` : null,
      failed: [...carried.splice(0), ...failed],
      ...(rendering?.frameBackpressure ? { framesInFlight: { mode: rendering.frameBackpressure.mode, skipped: rendering.frameBackpressure.skipped - skippedBefore } } : {}),
      ...(presentedBefore && presentedAfter ? {
        presentation: {
          drawn: presentedAfter.drawn - presentedBefore.drawn, held: presentedAfter.held - presentedBefore.held, ms: sampleMsTaken,
          heldReasons: heldReasonsSince(presentedBefore.heldReasons, presentedAfter.heldReasons),
        },
      } : {}),
      ...(work ? { work } : {}),
      ...(memory ? { memory } : {}),
      ...(sampled.drawPasses ? { drawPasses: sampled.drawPasses } : {}),
      ...(rendering?.programs ? { programs: rendering.programs } : {}),
      ...(interleaved ? {
        ...(gpuBusy && rendering?.gpuBusy ? { gpuBusy: { ...rendering.gpuBusy } } : {}),
        ...(rendering?.settings ? { settings: { ...rendering.settings } } : {}),
        unsettled: { firstDraws: (rendering?.firstDraws?.draws ?? 0) - firstDrawsBefore, compiling: sampled.compiling, settleMs: settled.ms },
        ...(sampled.occlusion ? { occlusion: sampled.occlusion } : {}),
      } : {}),
    };
    return sample;
  };
  /** The settings of the last baseline or warm-up window measured from `view`: what a step there is compared with. */
  const reference = (view: string | undefined) =>
    samples.findLast((sample) => (sample.warmup || isBreakdownBaseline(sample)) && sample.view === view && sample.settings)?.settings;
  // The last step skipped: the baseline after it would repeat the one before it.
  let skippedLast = false;
  try {
    // The base first, so the warm-up runs at the baseline the steps are compared with.
    if (interleaved) {
      await runAll(base.commands, carried);
      await warmUp(sceneName, deps, { draws: waitForDraws, settle, unsettledNote }, measure, samples, mode === "profile"
        ? { windowMs: limits.profileWarmupWindowMs, windows: PROFILE_WARMUP_WINDOWS, ms: Number.POSITIVE_INFINITY }
        : { windowMs: limits.breakdownWarmupWindowMs, windows: Number.POSITIVE_INFINITY, ms: limits.breakdownWarmupMs });
    }
    if (mode === "profile") {
      const rendering = play.snapshot().rendering;
      if (profile) {
        profile.instancePool = rendering?.instancePool ?? null;
        profile.holdRate = profileHoldRate(samples);
      }
      steps = breakdownSequence(featureTestProfilePlan(profileState(reference(undefined), rendering?.frameBackpressure?.mode)).views);
    }
    for (const [index, step] of steps.entries()) {
      if (step.baseline && skippedLast) { skippedLast = false; continue; }
      /**
       * Back to the base for the step that follows. After a Breakdown's last one nothing follows but Stop (see the end
       * of the sweep); `skipsBaseline`: the baseline right after this step is not measured.
       */
      const restoreForNext = async (skipsBaseline: boolean) => {
        const follows = steps.slice(index + 1).some((later, offset) => !(skipsBaseline && offset === 0 && later.baseline));
        if (profile || follows) await restore();
      };
      deps.onProgress?.(`${sceneName}: ${interleaved ? "measuring" : "benchmarking"} ${step.label}`);
      const failed: string[] = [];
      if (step.restore) pendingRestore.push(...step.restore);
      await runAll(step.commands, failed);
      // A view that does not draw again (shaders, render targets or a lost graphics context) ends this scene's
      // sweep: more changes on top would only pile up work and memory.
      const drew = await waitForDraws();
      const steady = drew.outcome !== "stopped";
      if (!steady) failed.push(stoppedNote);
      const skip = interleaved && steady && !step.baseline && !failed.length
        ? breakdownSkip(step.fields, reference(step.view), play.snapshot().rendering?.settings)
        : null;
      if (skip) {
        deps.onProgress?.(`${sceneName}: skipped ${step.label} (${skip})`);
        samples.push({
          label: step.label, frames: null, runtimeFps: null, cpuMs: null, gpuMs: null, drawCalls: 0, resolution: null,
          failed: carried.splice(0), baseline: false, skipped: skip, ...(step.view ? { view: step.view } : {}),
        });
        skippedLast = true;
        await restoreForNext(true);
        continue;
      }
      skippedLast = false;
      if (drew.note) failed.push(drew.note);
      // The view draws again, but the variants a step asked for may still be first drawing or compiling: sampling
      // them would measure their compiles, not the step.
      const settled = steady ? await settle() : { quiet: true, ms: 0 };
      if (!settled.quiet) failed.push(unsettledNote("step"));
      const sample = await measure(step.label, failed, limits.playSampleMs, settled);
      if (interleaved) {
        sample.baseline = step.baseline === true;
        if (step.view) sample.view = step.view;
      }
      samples.push(sample);
      if (!steady) break;
      await restoreForNext(false);
    }
  } finally {
    if (!signal.aborted) {
      if (gpuBusy) await run("gpubusy off");
      if (profile) {
        // The session's own quality again, as Play started it.
        await run("quality reset");
        for (const line of pendingRestore.splice(0)) await run(line);
        // Back as the session was before the first step: `quality reset` must not have dropped or kept anything else.
        await checkProfileRestored(play, waitForDraws, samples.find((sample) => sample.warmup)?.settings, profile);
      } else {
        // A Benchmark's or a Breakdown's session ends with its sweep: the caller stops Play next. Nothing the view draws
        // is restored (quality, render path, camera), since a view about to be torn down would prepare it first: a tier
        // switch allocates its render targets beside the last step's and compiles its variants, with Stop already under
        // way. The cap is pacing only.
        await run(`framecap ${cap ?? 60}`);
      }
    }
  }
}

/** Waits for the view to draw the restored settings, then records what still differs from `before` in `profile.endChanges`. */
async function checkProfileRestored(
  play: PlayProbe, waitForDraws: () => Promise<DrawWait>,
  before: Readonly<Record<string, string>> | undefined, profile: FeatureTestProfileResult,
): Promise<void> {
  if (!before) return;
  await waitForDraws();
  const after = play.snapshot().rendering?.settings;
  if (after) profile.endChanges = settingsChanges(before, after);
}

/**
 * Before a Breakdown's or Profile's first step: samples the baseline in windows of `bounds.windowMs` until two
 * consecutive windows differ by under 3% (GPU-busy median where measured, else mean frame interval), for at most
 * `bounds.windows` windows and `bounds.ms`, so a device that heats up during the run starts the steps near its steady
 * state. Each window is kept as a `warmup` sample. Each waits as the sweep's steps do (`waits`); a wait in which the
 * view stopped drawing (a Breakdown's: did not draw without held frames) ends the warm-up.
 */
async function warmUp(
  sceneName: string,
  deps: FeatureTestCheckDeps,
  waits: {
    draws: () => Promise<DrawWait & { note: string | null }>;
    settle: () => Promise<{ quiet: boolean; ms: number }>;
    unsettledNote: (what: string) => string;
  },
  measure: (label: string, failed: string[], sampleMs: number, settled: { quiet: boolean; ms: number }) => Promise<FeatureTestBenchmarkSample>,
  samples: FeatureTestBenchmarkSample[],
  bounds: { windowMs: number; windows: number; ms: number },
): Promise<void> {
  const started = deps.now();
  let previous: number | null = null;
  for (let window = 1; ; window++) {
    deps.onProgress?.(`${sceneName}: warming up (${window})`);
    const drew = await waits.draws();
    const steady = drew.outcome !== "stopped";
    const settled = steady ? await waits.settle() : { quiet: true, ms: 0 };
    const failed = [...drew.note ? [drew.note] : [], ...settled.quiet ? [] : [waits.unsettledNote("window")]];
    const sample = await measure(`warm-up ${window}`, failed, bounds.windowMs, settled);
    sample.warmup = true;
    samples.push(sample);
    const value = sample.gpuBusy?.medianMs ?? meanFrameMs(sample.frames);
    const stable = value !== null && previous !== null && Math.abs(value - previous) <= previous * WARMUP_STABLE;
    if (!steady || stable || value === null || window >= bounds.windows || deps.now() - started >= bounds.ms) return;
    previous = value;
  }
}

/** How many frames' CPU times a stubbed sample reads, half a second apart, after half a second for the first stubbed frames to end. */
const STUBBED_CPU_READS = 4;

/**
 * A frame's CPU time while the game view's draws are stubbed (`PlayProbe.stubWebGlDraws`); null where they cannot be.
 * Each read follows half a second of stubbed frames, so none is of a frame that still drew. The canvas shows no new
 * frame meanwhile, and the view draws again however the sample ends.
 */
async function sampleCpuWithoutDraws(play: PlayProbe, deps: FeatureTestCheckDeps, signal: AbortSignal): Promise<CounterStats | null> {
  if (!play.stubWebGlDraws(true)) return null;
  const cpu: number[] = [];
  try {
    for (let read = 0; read < STUBBED_CPU_READS; read++) {
      await deps.sleep(500, signal);
      const rendering = play.snapshot().rendering;
      if (rendering) cpu.push(rendering.cpuMs);
    }
  } finally {
    play.stubWebGlDraws(false);
  }
  return counterStats(cpu);
}

/** Reads the per-frame counters every half second while `frames` samples the frame intervals. */
async function sampleWithCounters(
  play: PlayProbe, frames: Promise<FrameStats | null>, deps: FeatureTestCheckDeps, signal: AbortSignal,
): Promise<{
  frames: FrameStats | null; draws: CounterStats | null; cpu: CounterStats | null; gpu: CounterStats | null; compiling: number;
  occlusion: FeatureTestBenchmarkSample["occlusion"] | null;
  drawPasses: FeatureTestBenchmarkSample["drawPasses"] | null;
}> {
  let compiling = 0;
  const cpu: number[] = [];
  const gpu: number[] = [];
  const draws: number[] = [];
  const passes = new Map<DrawPass, number[]>();
  const occlusion = { tested: [] as number[], culled: [] as number[], triangles: [] as number[], ms: [] as number[] };
  let sampling = true;
  const done = frames.finally(() => { sampling = false; });
  while (sampling) {
    const snapshot = play.snapshot();
    draws.push(snapshot.drawCalls);
    compiling = Math.max(compiling, deps.compiling?.() ?? 0);
    const rendering = snapshot.rendering;
    if (rendering) {
      cpu.push(rendering.cpuMs);
      if (rendering.gpuMs !== null) gpu.push(rendering.gpuMs);
      for (const [pass, count] of Object.entries(rendering.drawPasses ?? {}) as [DrawPass, number][]) {
        const counts = passes.get(pass) ?? [];
        counts.push(count);
        passes.set(pass, counts);
      }
      if (rendering.occlusion) {
        occlusion.tested.push(rendering.occlusion.tested);
        occlusion.culled.push(rendering.occlusion.culled);
        occlusion.triangles.push(rendering.occlusion.triangles);
        occlusion.ms.push(rendering.occlusion.ms);
      }
    }
    await Promise.race([done, deps.sleep(500, signal)]);
  }
  const median = (values: number[]) => counterStats(values)!.median;
  return {
    frames: await done, draws: counterStats(draws), cpu: counterStats(cpu), gpu: counterStats(gpu), compiling,
    occlusion: occlusion.tested.length ? {
      tested: median(occlusion.tested), culled: median(occlusion.culled), triangles: median(occlusion.triangles), ms: median(occlusion.ms),
    } : null,
    drawPasses: passes.size ? Object.fromEntries([...passes].map(([pass, counts]) => [pass, median(counts)])) : null,
  };
}

/** The median, minimum and maximum of a counter's samples, or null without one. */
export function counterStats(values: readonly number[]): CounterStats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { median, min: sorted[0]!, max: sorted.at(-1)!, samples: sorted.length };
}

/** Ends `text` with exactly one full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

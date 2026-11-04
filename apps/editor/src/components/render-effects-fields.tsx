import { RENDER_EFFECTS_LIMITS, type RenderEffectsSettings } from "@haptic/core";
import { Fragment, type ReactNode } from "react";
import { ColorField, NumberField, colorToHex } from "@haptic/editor-kit";
import { Switch } from "@haptic/ui/components/switch";
import { FieldGroup, FieldLegend, FieldSet } from "@haptic/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { EffectRow } from "./render-effects-rows";
import { readEffect, type EffectsChange, type EffectsPath, type EffectsScope } from "./render-effects-scope";

type Limits = readonly [number, number];

/**
 * One Post Processing row. Project Settings and a Scene's overrides render
 * the same table, and the Scene Inspector's filter reads its labels and
 * hints, so a row added here appears everywhere at once.
 */
type EffectRowSpec = {
  path: EffectsPath;
  /** Id suffix after `project-effects-` or `scene-effects-`. */
  suffix: string;
  label: string;
  /** The label's tooltip and the control's screen-reader description. */
  hint?: string;
  control:
    | { kind: "toggle" }
    | { kind: "number"; limits: Limits; step: number }
    | { kind: "select"; options: Readonly<Record<string, string>>; also?: (value: string, effects: RenderEffectsSettings) => EffectsChange[] }
    | { kind: "color" }
    | { kind: "lut" };
  /** Shown only while this switch is on. */
  shownWhen?: EffectsPath;
  /** Indented under the switch that shows it. */
  dependent?: boolean;
  /** Applies in the Scene Linear Color Pipeline only, so it is disabled in Legacy Display. */
  sceneLinear?: boolean;
};

const PIPELINE_LABELS = { legacyDisplay: "Legacy Display", sceneLinear: "Scene Linear" } as const;
const TONE_MAPPING_LABELS = { none: "None", standard: "Standard", aces: "ACES", neutral: "Neutral" } as const;
const SPATIAL_SCALE_HINT = "Multiplies Post Processing Resolution Scale, with a quarter-resolution minimum.";

const number = (limits: Limits, step: number) => ({ kind: "number" as const, limits, step });
const TOGGLE = { kind: "toggle" } as const;
const L = RENDER_EFFECTS_LIMITS;

/** The rows in display order, in groups; a group with a legend is its own fieldset. */
const EFFECT_GROUPS: ReadonlyArray<{ legend?: string; rows: readonly EffectRowSpec[] }> = [
  { rows: [
    { path: ["ambientOcclusion", "enabled"], suffix: "ambient-occlusion", label: "Ambient Occlusion", control: TOGGLE,
      hint: "Darkens creases and contact points between visible PBR surfaces. Runs where Post Processing quality allows it (Medium and above by default)." },
    { path: ["ambientOcclusion", "radius"], suffix: "occlusion-radius", label: "Occlusion Radius", control: number(L.ambientOcclusionRadius, 0.05),
      shownWhen: ["ambientOcclusion", "enabled"], hint: "Distance searched around each surface point, in scene units." },
    { path: ["ambientOcclusion", "strength"], suffix: "occlusion-strength", label: "Occlusion Strength", control: number(L.ambientOcclusionStrength, 0.01),
      shownWhen: ["ambientOcclusion", "enabled"] },
    { path: ["ambientOcclusion", "maxDistance"], suffix: "occlusion-distance", label: "Occlusion Distance", control: number(L.ambientOcclusionDistance, 1),
      shownWhen: ["ambientOcclusion", "enabled"], hint: "Occlusion fades out toward this distance from the camera, in scene units." },
    { path: ["ambientOcclusion", "resolutionScale"], suffix: "occlusion-scale", label: "Occlusion Resolution Scale", control: number(L.spatialResolutionScale, 0.25),
      shownWhen: ["ambientOcclusion", "enabled"], hint: SPATIAL_SCALE_HINT },
    { path: ["ambientOcclusion", "samples"], suffix: "occlusion-samples", label: "Occlusion Samples", control: number(L.ambientOcclusionSamples, 1),
      shownWhen: ["ambientOcclusion", "enabled"] },
    { path: ["reflections", "enabled"], suffix: "reflections", label: "Real-Time Reflections", control: TOGGLE,
      hint: "Reflects visible scene objects on lit metal and smooth surfaces, in PBR and CEL. Runs where Post Processing quality allows it (High and above by default)." },
    { path: ["reflections", "resolutionScale"], suffix: "reflection-scale", label: "Reflection Resolution Scale", control: number(L.spatialResolutionScale, 0.25),
      shownWhen: ["reflections", "enabled"] },
    { path: ["reflections", "maxSteps"], suffix: "reflection-steps", label: "Reflection Steps", control: number(L.reflectionSteps, 1), shownWhen: ["reflections", "enabled"] },
    { path: ["reflections", "maxDistance"], suffix: "reflection-distance", label: "Reflection Distance", control: number(L.reflectionDistance, 1), shownWhen: ["reflections", "enabled"] },
    { path: ["reflections", "thickness"], suffix: "reflection-thickness", label: "Reflection Thickness", control: number(L.reflectionThickness, 0.01), shownWhen: ["reflections", "enabled"] },
    { path: ["reflections", "strength"], suffix: "reflection-strength", label: "Reflection Strength", control: number(L.reflectionStrength, 0.01), shownWhen: ["reflections", "enabled"] },
  ] },
  { legend: "Volumetric Fog", rows: [
    { path: ["volumetricLighting", "enabled"], suffix: "volumetric", label: "Scene-Wide Fog", control: TOGGLE,
      hint: "Fog lit by directional, point and spot lights; enable light shadows for occluded beams. Runs where Post Processing quality allows it (High and above by default); Fog Volumes always render and share the controls below." },
    { path: ["volumetricLighting", "density"], suffix: "volumetric-density", label: "Scene-Wide Fog Density", control: number(L.volumetricDensity, 0.001),
      shownWhen: ["volumetricLighting", "enabled"], hint: "Fog thickness per scene unit at and below Fog Height. Zero removes scene-wide haze; Fog Volumes still contribute." },
    { path: ["volumetricLighting", "height"], suffix: "volumetric-height", label: "Fog Height", control: number(L.volumetricHeight, 0.5),
      shownWhen: ["volumetricLighting", "enabled"], hint: "World height below which scene-wide fog is at full density." },
    { path: ["volumetricLighting", "heightFalloff"], suffix: "volumetric-height-falloff", label: "Fog Height Falloff", control: number(L.volumetricHeightFalloff, 0.01),
      shownWhen: ["volumetricLighting", "enabled"], hint: "How fast fog thins above Fog Height, per scene unit. Zero keeps it the same at every height." },
    { path: ["volumetricLighting", "intensity"], suffix: "volumetric-intensity", label: "Volumetric Intensity", control: number(L.volumetricIntensity, 0.01),
      hint: "Brightness of scattered light. Zero removes light beams but keeps fog darkening." },
    { path: ["volumetricLighting", "maxDistance"], suffix: "volumetric-distance", label: "Volumetric Distance", control: number(L.volumetricDistance, 1),
      hint: "Maximum distance sampled from the camera, in scene units. Scene surfaces stop the fog ray earlier." },
    { path: ["volumetricLighting", "anisotropy"], suffix: "volumetric-anisotropy", label: "Scattering Anisotropy", control: number(L.volumetricAnisotropy, 0.01),
      hint: "Zero scatters evenly. Positive values strengthen beams when looking toward a light; negative values favor the opposite view." },
    { path: ["volumetricLighting", "resolutionScale"], suffix: "volumetric-scale", label: "Volumetric Resolution Scale", control: number(L.spatialResolutionScale, 0.25),
      hint: SPATIAL_SCALE_HINT },
    { path: ["volumetricLighting", "steps"], suffix: "volumetric-steps", label: "Volumetric Steps", control: number(L.volumetricSteps, 1) },
    { path: ["volumetricLighting", "maxLights"], suffix: "volumetric-lights", label: "Volumetric Light Limit", control: number(L.volumetricLights, 1),
      hint: "Hemispheric fill and area lights never contribute." },
  ] },
  { rows: [
    { path: ["colorPipeline", "mode"], suffix: "pipeline", label: "Color Pipeline",
      hint: "Scene Linear renders PBR in HDR, then applies tone mapping, exposure and contrast. CEL stays in display space.",
      // Scene Linear without tone mapping clips its highlights: switching to it picks Neutral.
      control: { kind: "select", options: PIPELINE_LABELS,
        also: (mode, effects) => (mode === "sceneLinear" && effects.toneMapping === "none" ? [[["toneMapping"], "neutral"]] : []) } },
    { path: ["toneMapping"], suffix: "tone-mapping", label: "Tone Mapping", control: { kind: "select", options: TONE_MAPPING_LABELS }, sceneLinear: true,
      hint: "Applies in the Scene Linear display stage only." },
    { path: ["exposure"], suffix: "exposure", label: "Exposure", control: number(L.exposure, 0.01), sceneLinear: true,
      hint: "Scene Linear brightness multiplier before tone mapping." },
    { path: ["contrast"], suffix: "contrast", label: "Contrast", control: number(L.contrast, 0.01), sceneLinear: true,
      hint: "Scene Linear contrast curve strength." },
    { path: ["whiteBalance", "enabled"], suffix: "white-balance", label: "White Balance", control: TOGGLE, sceneLinear: true,
      hint: "Scene Linear correction for the color of the scene lighting." },
    { path: ["whiteBalance", "temperature"], suffix: "white-balance-temperature", label: "Temperature (K)", control: number(L.whiteBalanceTemperature, 50),
      shownWhen: ["whiteBalance", "enabled"], dependent: true, sceneLinear: true, hint: "Illuminant to neutralize. Low values cool warm light; 6500 is neutral." },
    { path: ["whiteBalance", "tint"], suffix: "white-balance-tint", label: "Tint", control: number(L.whiteBalanceTint, 1),
      shownWhen: ["whiteBalance", "enabled"], dependent: true, sceneLinear: true, hint: "Positive shifts toward magenta, negative toward green." },
    { path: ["bloom", "enabled"], suffix: "bloom", label: "Bloom", control: TOGGLE },
    { path: ["bloom", "threshold"], suffix: "bloom-threshold", label: "Bloom Threshold", control: number(L.bloomThreshold, 0.01), shownWhen: ["bloom", "enabled"], dependent: true },
    { path: ["bloom", "weight"], suffix: "bloom-weight", label: "Bloom Weight", control: number(L.bloomWeight, 0.01), shownWhen: ["bloom", "enabled"], dependent: true },
    { path: ["bloom", "kernel"], suffix: "bloom-kernel", label: "Bloom Kernel", control: number(L.bloomKernel, 1), shownWhen: ["bloom", "enabled"], dependent: true },
    { path: ["bloom", "scale"], suffix: "bloom-scale", label: "Bloom Scale", control: number(L.bloomScale, 0.05), shownWhen: ["bloom", "enabled"], dependent: true,
      hint: "Bloom target size relative to the post-processing resolution." },
    { path: ["vignette", "enabled"], suffix: "vignette", label: "Vignette", control: TOGGLE, hint: "Applies in every Color Pipeline mode." },
    { path: ["vignette", "weight"], suffix: "vignette-weight", label: "Vignette Weight", control: number(L.vignetteWeight, 0.01), shownWhen: ["vignette", "enabled"], dependent: true },
    { path: ["vignette", "color"], suffix: "vignette-color", label: "Vignette Color", control: { kind: "color" }, shownWhen: ["vignette", "enabled"], dependent: true },
    { path: ["colorGrading", "enabled"], suffix: "color-grading", label: "Color Grading", control: TOGGLE,
      hint: "Remaps final colors through a lookup table, in every Color Pipeline mode." },
    { path: ["colorGrading", "lutTextureGuid"], suffix: "lut", label: "LUT Texture", control: { kind: "lut" }, shownWhen: ["colorGrading", "enabled"], dependent: true,
      hint: "A horizontal strip of square slices, such as 256×16 or 1024×32. Set the Texture's Usage to Color Grading LUT so it stays uncompressed." },
    { path: ["upscaling", "enabled"], suffix: "upscaling", label: "FSR Upscaling", control: TOGGLE,
      hint: "Renders the scene and its effects at a lower resolution, then upscales and sharpens with AMD FSR 1." },
    { path: ["upscaling", "renderScale"], suffix: "upscaling-scale", label: "Render Scale", control: number(L.upscalingRenderScale, 0.01),
      shownWhen: ["upscaling", "enabled"], dependent: true, hint: "Fraction of the output width and height rendered. 1 disables upscaling." },
    { path: ["upscaling", "sharpness"], suffix: "upscaling-sharpness", label: "Sharpness", control: number(L.upscalingSharpness, 0.05),
      shownWhen: ["upscaling", "enabled"], dependent: true, hint: "Sharpening reduction in stops. 0 is the sharpest." },
  ] },
];

/** Every row label, legend, option and hint, for the Scene Inspector's property filter. */
export const RENDER_EFFECTS_SEARCH_TEXT = EFFECT_GROUPS.flatMap((group) => [
  group.legend ?? "",
  ...group.rows.flatMap((row) => [row.label, row.hint ?? "", ...(row.control.kind === "select" ? Object.values(row.control.options) : [])]),
]).filter(Boolean).join(" ");

type Props = {
  scope: EffectsScope;
  hideTitle?: boolean;
  /** Texture picker control for the grading LUT, owned by the host. */
  lutControl?: (control: { id: string; disabled: boolean; describedBy?: string }) => ReactNode;
  /** The Scene status line's name for a LUT Texture. */
  lutName?: (guid: string | null) => string;
};

/** The Post Processing group, in Project Settings or as a Scene's overrides. */
export function RenderEffectsFields({ scope, hideTitle = false, lutControl, lutName = (guid) => guid ?? "None" }: Props) {
  const value = scope.value;
  const sceneLinear = value.colorPipeline.mode === "sceneLinear";
  const row = (spec: EffectRowSpec) => {
    if (spec.shownWhen && readEffect(value, spec.shownWhen) !== true) return null;
    const current = readEffect(value, spec.path);
    const control = spec.control;
    const display = (shown: unknown) =>
      control.kind === "select" ? control.options[String(shown)] ?? String(shown)
        : control.kind === "color" ? colorToHex(shown as [number, number, number])
          : control.kind === "lut" ? lutName(typeof shown === "string" ? shown : null)
            : typeof shown === "boolean" ? (shown ? "On" : "Off") : String(shown);
    return (
      <EffectRow key={spec.suffix} scope={scope} path={spec.path} suffix={spec.suffix} label={spec.label} hint={spec.hint}
        toggle={control.kind === "toggle"} dependent={spec.dependent} disabled={spec.sceneLinear && !sceneLinear} display={display}>
        {(field) => {
          switch (control.kind) {
            case "toggle":
              return <Switch id={field.id} aria-describedby={field.describedBy} data-testid={field.id} checked={current === true}
                disabled={field.disabled} onCheckedChange={(checked) => scope.set([spec.path, checked === true])} />;
            case "number":
              return <NumberField id={field.id} aria-describedby={field.describedBy} data-testid={field.id} value={Number(current)}
                min={control.limits[0]} max={control.limits[1]} step={control.step} disabled={field.disabled}
                onChange={(next) => scope.set([spec.path, next])} />;
            case "select":
              return (
                <Select value={String(current)} disabled={field.disabled}
                  onValueChange={(next) => {
                    if (next === null || !(next in control.options)) return;
                    scope.set([spec.path, next], ...(control.also?.(next, value) ?? []));
                  }}>
                  <SelectTrigger id={field.id} aria-describedby={field.describedBy} data-testid={field.id}>
                    <SelectValue>{control.options[String(current)]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent><SelectGroup>
                    {Object.entries(control.options).map(([option, label]) => <SelectItem key={option} value={option}>{label}</SelectItem>)}
                  </SelectGroup></SelectContent>
                </Select>
              );
            case "color":
              return <ColorField id={field.id} data-testid={field.id} value={current as [number, number, number]} disabled={field.disabled}
                onChange={(color) => scope.set([spec.path, color])} />;
            case "lut":
              return lutControl?.(field) ?? null;
          }
        }}
      </EffectRow>
    );
  };
  return (
    <FieldSet data-testid={scope.scene ? "scene-render-effects" : "project-render-effects"}>
      <FieldLegend className={hideTitle ? "sr-only" : undefined}>Post Processing</FieldLegend>
      <FieldGroup className="gap-2">
        {EFFECT_GROUPS.map((group, index) => group.legend ? (
          <FieldSet key={group.legend} className="gap-2">
            <FieldLegend>{group.legend}</FieldLegend>
            <FieldGroup className="gap-2">{group.rows.map(row)}</FieldGroup>
          </FieldSet>
        ) : <Fragment key={index}>{group.rows.map(row)}</Fragment>)}
      </FieldGroup>
    </FieldSet>
  );
}

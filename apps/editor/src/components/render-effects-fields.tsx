import { RENDER_EFFECTS_LIMITS } from "@haptic/core";
import type { ReactNode } from "react";
import { ColorField, NumberField, colorToHex } from "@haptic/editor-kit";
import { Switch } from "@haptic/ui/components/switch";
import { SpatialEffectsFields, SPATIAL_EFFECTS_SEARCH_TEXT } from "./spatial-effects-fields";
import { EffectRow } from "./render-effects-rows";
import { readEffect as readValue, type EffectsPath, type EffectsScope } from "./render-effects-scope";
import {
  FieldGroup,
  FieldLegend,
  FieldSet,
} from "@haptic/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";

const pipelineLabels = {
  legacyDisplay: "Legacy Display",
  sceneLinear: "Scene Linear",
} as const;

const toneMappingLabels = {
  none: "None",
  standard: "Standard",
  aces: "ACES",
  neutral: "Neutral",
} as const;

/** Label tooltips; rows whose control is described by one keep it as screen-reader text. */
const hints = {
  pipeline: "Scene Linear renders PBR in HDR, then applies tone mapping, exposure and contrast. CEL stays in display space.",
  toneMapping: "Applies in the Scene Linear display stage only.",
  exposure: "Scene Linear brightness multiplier before tone mapping.",
  contrast: "Scene Linear contrast curve strength.",
  whiteBalance: "Scene Linear correction for the color of the scene lighting.",
  temperature: "Illuminant to neutralize. Low values cool warm light; 6500 is neutral.",
  tint: "Positive shifts toward magenta, negative toward green.",
  bloomScale: "Bloom target size relative to the post-processing resolution.",
  vignette: "Applies in every Color Pipeline mode.",
  colorGrading: "Remaps final colors through a lookup table, in every Color Pipeline mode.",
  lut: "A horizontal strip of square slices, such as 256×16 or 1024×32. Set the Texture's Usage to Color Grading LUT so it stays uncompressed.",
  upscaling: "Renders the scene and its effects at a lower resolution, then upscales and sharpens with AMD FSR 1.",
  renderScale: "Fraction of the output width and height rendered. 1 disables upscaling.",
  sharpness: "Sharpening reduction in stops. 0 is the sharpest.",
} as const;

type Props = {
  scope: EffectsScope;
  hideTitle?: boolean;
  /** Texture picker control for the grading LUT, owned by the host. */
  lutControl?: (control: { id: string; disabled: boolean; describedBy?: string }) => ReactNode;
  /** The Scene status line's name for a LUT Texture. */
  lutName?: (guid: string | null) => string;
};

const labelled = (labels: Record<string, string>) => (value: unknown) => labels[String(value)] ?? String(value);

/** Every row label and hint, for the Inspector's property filter. */
export const RENDER_EFFECTS_SEARCH_TEXT = [
  "Post Processing", "Color Pipeline", ...Object.values(pipelineLabels), "Tone Mapping", ...Object.values(toneMappingLabels),
  "Exposure", "Contrast", "White Balance", "Temperature (K)", "Tint",
  "Bloom", "Bloom Threshold", "Bloom Weight", "Bloom Kernel", "Bloom Scale",
  "Vignette", "Vignette Weight", "Vignette Color", "Color Grading", "LUT Texture",
  "FSR Upscaling", "Render Scale", "Sharpness",
  ...Object.values(hints),
  SPATIAL_EFFECTS_SEARCH_TEXT,
].join(" ");

/** The Post Processing group: the color pipeline stage plus the effect chain
 * (bloom, vignette, grading, upscaling and the spatial effects), in Project
 * Settings or as a Scene's overrides. */
export function RenderEffectsFields({ scope, hideTitle = false, lutControl, lutName = (guid) => guid ?? "None" }: Props) {
  const value = scope.value;
  const sceneLinear = value.colorPipeline.mode === "sceneLinear";
  const number = (
    path: EffectsPath,
    suffix: string,
    label: string,
    limits: readonly [number, number],
    step: number,
    options: { hint?: string; dependent?: boolean; disabled?: boolean } = {},
  ) => (
    <EffectRow scope={scope} path={path} suffix={suffix} label={label} hint={options.hint} dependent={options.dependent} disabled={options.disabled}>
      {(control) => (
        <NumberField
          id={control.id}
          aria-describedby={control.describedBy}
          data-testid={control.id}
          value={Number(readValue(value, path))}
          min={limits[0]}
          max={limits[1]}
          step={step}
          disabled={control.disabled}
          onChange={(next) => scope.set([path, next])}
        />
      )}
    </EffectRow>
  );
  const toggle = (path: EffectsPath, suffix: string, label: string, hint?: string, disabled = false) => (
    <EffectRow scope={scope} path={path} suffix={suffix} label={label} hint={hint} toggle disabled={disabled}>
      {(control) => (
        <Switch
          id={control.id}
          aria-describedby={control.describedBy}
          data-testid={control.id}
          checked={readValue(value, path) === true}
          disabled={control.disabled}
          onCheckedChange={(checked) => scope.set([path, checked === true])}
        />
      )}
    </EffectRow>
  );
  return (
    <FieldSet data-testid={scope.scene ? "scene-render-effects" : "project-render-effects"}>
      <FieldLegend className={hideTitle ? "sr-only" : undefined}>Post Processing</FieldLegend>
      <FieldGroup className="gap-2">
        <SpatialEffectsFields scope={scope} />
        <EffectRow scope={scope} path={["colorPipeline", "mode"]} suffix="pipeline" label="Color Pipeline" hint={hints.pipeline} display={labelled(pipelineLabels)}>
          {(control) => (
            <Select
              value={value.colorPipeline.mode}
              disabled={control.disabled}
              onValueChange={(mode) => {
                if (mode !== "legacyDisplay" && mode !== "sceneLinear") return;
                // Scene Linear without tone mapping clips its highlights: switching to it picks Neutral.
                scope.set(
                  [["colorPipeline", "mode"], mode],
                  ...(mode === "sceneLinear" && value.toneMapping === "none" ? [[["toneMapping"], "neutral"] as const] : []),
                );
              }}
            >
              <SelectTrigger id={control.id} aria-describedby={control.describedBy} data-testid={control.id}>
                <SelectValue>{pipelineLabels[value.colorPipeline.mode]}</SelectValue>
              </SelectTrigger>
              <SelectContent><SelectGroup>
                {Object.entries(pipelineLabels).map(([mode, label]) => (
                  <SelectItem key={mode} value={mode}>{label}</SelectItem>
                ))}
              </SelectGroup></SelectContent>
            </Select>
          )}
        </EffectRow>
        <EffectRow scope={scope} path={["toneMapping"]} suffix="tone-mapping" label="Tone Mapping" hint={hints.toneMapping} disabled={!sceneLinear} display={labelled(toneMappingLabels)}>
          {(control) => (
            <Select
              value={value.toneMapping}
              disabled={control.disabled}
              onValueChange={(toneMapping) => {
                if (toneMapping && toneMapping in toneMappingLabels) scope.set([["toneMapping"], toneMapping]);
              }}
            >
              <SelectTrigger id={control.id} aria-describedby={control.describedBy} data-testid={control.id}>
                <SelectValue>{toneMappingLabels[value.toneMapping]}</SelectValue>
              </SelectTrigger>
              <SelectContent><SelectGroup>
                {Object.entries(toneMappingLabels).map(([mode, label]) => (
                  <SelectItem key={mode} value={mode}>{label}</SelectItem>
                ))}
              </SelectGroup></SelectContent>
            </Select>
          )}
        </EffectRow>
        {number(["exposure"], "exposure", "Exposure", RENDER_EFFECTS_LIMITS.exposure, 0.01, { hint: hints.exposure, disabled: !sceneLinear })}
        {number(["contrast"], "contrast", "Contrast", RENDER_EFFECTS_LIMITS.contrast, 0.01, { hint: hints.contrast, disabled: !sceneLinear })}
        {toggle(["whiteBalance", "enabled"], "white-balance", "White Balance", hints.whiteBalance, !sceneLinear)}
        {value.whiteBalance.enabled ? (
          <>
            {number(["whiteBalance", "temperature"], "white-balance-temperature", "Temperature (K)", RENDER_EFFECTS_LIMITS.whiteBalanceTemperature, 50,
              { hint: hints.temperature, dependent: true, disabled: !sceneLinear })}
            {number(["whiteBalance", "tint"], "white-balance-tint", "Tint", RENDER_EFFECTS_LIMITS.whiteBalanceTint, 1,
              { hint: hints.tint, dependent: true, disabled: !sceneLinear })}
          </>
        ) : null}
        {toggle(["bloom", "enabled"], "bloom", "Bloom")}
        {value.bloom.enabled ? (
          <>
            {number(["bloom", "threshold"], "bloom-threshold", "Bloom Threshold", RENDER_EFFECTS_LIMITS.bloomThreshold, 0.01, { dependent: true })}
            {number(["bloom", "weight"], "bloom-weight", "Bloom Weight", RENDER_EFFECTS_LIMITS.bloomWeight, 0.01, { dependent: true })}
            {number(["bloom", "kernel"], "bloom-kernel", "Bloom Kernel", RENDER_EFFECTS_LIMITS.bloomKernel, 1, { dependent: true })}
            {number(["bloom", "scale"], "bloom-scale", "Bloom Scale", RENDER_EFFECTS_LIMITS.bloomScale, 0.05, { hint: hints.bloomScale, dependent: true })}
          </>
        ) : null}
        {toggle(["vignette", "enabled"], "vignette", "Vignette", hints.vignette)}
        {value.vignette.enabled ? (
          <>
            {number(["vignette", "weight"], "vignette-weight", "Vignette Weight", RENDER_EFFECTS_LIMITS.vignetteWeight, 0.01, { dependent: true })}
            <EffectRow scope={scope} path={["vignette", "color"]} suffix="vignette-color" label="Vignette Color" dependent
              display={(color) => colorToHex(color as [number, number, number])}>
              {(control) => (
                <ColorField
                  id={control.id}
                  data-testid={control.id}
                  value={value.vignette.color}
                  disabled={control.disabled}
                  onChange={(color) => scope.set([["vignette", "color"], color])}
                />
              )}
            </EffectRow>
          </>
        ) : null}
        {toggle(["colorGrading", "enabled"], "color-grading", "Color Grading", hints.colorGrading)}
        {value.colorGrading.enabled ? (
          <EffectRow scope={scope} path={["colorGrading", "lutTextureGuid"]} suffix="lut" label="LUT Texture" hint={hints.lut} dependent
            display={(guid) => lutName(typeof guid === "string" ? guid : null)}>
            {(control) => lutControl?.(control)}
          </EffectRow>
        ) : null}
        {toggle(["upscaling", "enabled"], "upscaling", "FSR Upscaling", hints.upscaling)}
        {value.upscaling.enabled ? (
          <>
            {number(["upscaling", "renderScale"], "upscaling-scale", "Render Scale", RENDER_EFFECTS_LIMITS.upscalingRenderScale, 0.01,
              { hint: hints.renderScale, dependent: true })}
            {number(["upscaling", "sharpness"], "upscaling-sharpness", "Sharpness", RENDER_EFFECTS_LIMITS.upscalingSharpness, 0.05,
              { hint: hints.sharpness, dependent: true })}
          </>
        ) : null}
      </FieldGroup>
    </FieldSet>
  );
}

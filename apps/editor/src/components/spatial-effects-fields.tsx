import { NumberField } from "@haptic/editor-kit";
import { RENDER_EFFECTS_LIMITS } from "@haptic/core";
import { FieldGroup, FieldLegend, FieldSet } from "@haptic/ui/components/field";
import { Switch } from "@haptic/ui/components/switch";
import { EffectRow } from "./render-effects-rows";
import { readEffect, type EffectsPath, type EffectsScope } from "./render-effects-scope";

const hints = {
  ambientOcclusion: "Darkens creases and contact points between visible PBR surfaces. Runs where Post Processing quality allows it (Medium and above by default).",
  occlusionRadius: "Distance searched around each surface point, in scene units.",
  occlusionDistance: "Occlusion fades out toward this distance from the camera, in scene units.",
  spatialScale: "Multiplies Post Processing Resolution Scale, with a quarter-resolution minimum.",
  reflections: "Reflects visible scene objects on lit metal and smooth surfaces, in PBR and CEL. Runs where Post Processing quality allows it (High and above by default).",
  volumetric: "Fog lit by directional, point and spot lights; enable light shadows for occluded beams. Runs where Post Processing quality allows it (High and above by default); Fog Volumes always render and share the controls below.",
  volumetricDensity: "Fog thickness per scene unit at and below Fog Height. Zero removes scene-wide haze; Fog Volumes still contribute.",
  volumetricHeight: "World height below which scene-wide fog is at full density.",
  volumetricHeightFalloff: "How fast fog thins above Fog Height, per scene unit. Zero keeps it the same at every height.",
  volumetricIntensity: "Brightness of scattered light. Zero removes light beams but keeps fog darkening.",
  volumetricDistance: "Maximum distance sampled from the camera, in scene units. Scene surfaces stop the fog ray earlier.",
  volumetricAnisotropy: "Zero scatters evenly. Positive values strengthen beams when looking toward a light; negative values favor the opposite view.",
  volumetricLights: "Hemispheric fill and area lights never contribute.",
} as const;

/** Every row label and hint, for the Inspector's property filter. */
export const SPATIAL_EFFECTS_SEARCH_TEXT = [
  "Ambient Occlusion", "Occlusion Radius", "Occlusion Strength", "Occlusion Distance", "Occlusion Resolution Scale", "Occlusion Samples",
  "Real-Time Reflections", "Reflection Resolution Scale", "Reflection Steps", "Reflection Distance", "Reflection Thickness",
  "Reflection Strength", "Volumetric Fog", "Scene-Wide Fog", "Scene-Wide Fog Density", "Fog Height", "Fog Height Falloff",
  "Volumetric Intensity", "Volumetric Distance", "Scattering Anisotropy", "Volumetric Resolution Scale", "Volumetric Steps",
  "Volumetric Light Limit",
  ...Object.values(hints),
].join(" ");

export function SpatialEffectsFields({ scope }: { scope: EffectsScope }) {
  const value = scope.value;
  const number = (
    path: EffectsPath,
    suffix: string,
    label: string,
    limits: readonly [number, number],
    step = 0.01,
    hint?: string,
  ) => (
    <EffectRow key={suffix} scope={scope} path={path} suffix={suffix} label={label} hint={hint}>
      {(control) => (
        <NumberField
          id={control.id}
          data-testid={control.id}
          value={Number(readEffect(value, path))}
          min={limits[0]}
          max={limits[1]}
          step={step}
          disabled={control.disabled}
          onChange={(next) => scope.set([path, next])}
          aria-describedby={control.describedBy}
        />
      )}
    </EffectRow>
  );
  const toggle = (path: EffectsPath, suffix: string, label: string, hint: string) => (
    <EffectRow scope={scope} path={path} suffix={suffix} label={label} hint={hint} toggle>
      {(control) => (
        <Switch
          id={control.id}
          data-testid={control.id}
          aria-describedby={control.describedBy}
          checked={readEffect(value, path) === true}
          disabled={control.disabled}
          onCheckedChange={(enabled) => scope.set([path, enabled === true])}
        />
      )}
    </EffectRow>
  );
  return (
    <FieldGroup className="gap-2">
      {toggle(["ambientOcclusion", "enabled"], "ambient-occlusion", "Ambient Occlusion", hints.ambientOcclusion)}
      {value.ambientOcclusion.enabled ? (
        <>
          {number(["ambientOcclusion", "radius"], "occlusion-radius", "Occlusion Radius",
            RENDER_EFFECTS_LIMITS.ambientOcclusionRadius, 0.05, hints.occlusionRadius)}
          {number(["ambientOcclusion", "strength"], "occlusion-strength", "Occlusion Strength",
            RENDER_EFFECTS_LIMITS.ambientOcclusionStrength)}
          {number(["ambientOcclusion", "maxDistance"], "occlusion-distance", "Occlusion Distance",
            RENDER_EFFECTS_LIMITS.ambientOcclusionDistance, 1, hints.occlusionDistance)}
          {number(["ambientOcclusion", "resolutionScale"], "occlusion-scale", "Occlusion Resolution Scale",
            RENDER_EFFECTS_LIMITS.spatialResolutionScale, 0.25, hints.spatialScale)}
          {number(["ambientOcclusion", "samples"], "occlusion-samples", "Occlusion Samples",
            RENDER_EFFECTS_LIMITS.ambientOcclusionSamples, 1)}
        </>
      ) : null}
      {toggle(["reflections", "enabled"], "reflections", "Real-Time Reflections", hints.reflections)}
      {value.reflections.enabled ? (
        <>
          {number(["reflections", "resolutionScale"], "reflection-scale", "Reflection Resolution Scale",
            RENDER_EFFECTS_LIMITS.spatialResolutionScale, 0.25)}
          {number(["reflections", "maxSteps"], "reflection-steps", "Reflection Steps", RENDER_EFFECTS_LIMITS.reflectionSteps, 1)}
          {number(["reflections", "maxDistance"], "reflection-distance", "Reflection Distance", RENDER_EFFECTS_LIMITS.reflectionDistance, 1)}
          {number(["reflections", "thickness"], "reflection-thickness", "Reflection Thickness", RENDER_EFFECTS_LIMITS.reflectionThickness)}
          {number(["reflections", "strength"], "reflection-strength", "Reflection Strength", RENDER_EFFECTS_LIMITS.reflectionStrength)}
        </>
      ) : null}
      <FieldSet className="gap-2">
        <FieldLegend>Volumetric Fog</FieldLegend>
        <FieldGroup className="gap-2">
          {toggle(["volumetricLighting", "enabled"], "volumetric", "Scene-Wide Fog", hints.volumetric)}
          {value.volumetricLighting.enabled ? (
            <>
              {number(["volumetricLighting", "density"], "volumetric-density", "Scene-Wide Fog Density",
                RENDER_EFFECTS_LIMITS.volumetricDensity, 0.001, hints.volumetricDensity)}
              {number(["volumetricLighting", "height"], "volumetric-height", "Fog Height",
                RENDER_EFFECTS_LIMITS.volumetricHeight, 0.5, hints.volumetricHeight)}
              {number(["volumetricLighting", "heightFalloff"], "volumetric-height-falloff", "Fog Height Falloff",
                RENDER_EFFECTS_LIMITS.volumetricHeightFalloff, 0.01, hints.volumetricHeightFalloff)}
            </>
          ) : null}
          {number(["volumetricLighting", "intensity"], "volumetric-intensity", "Volumetric Intensity",
            RENDER_EFFECTS_LIMITS.volumetricIntensity, 0.01, hints.volumetricIntensity)}
          {number(["volumetricLighting", "maxDistance"], "volumetric-distance", "Volumetric Distance",
            RENDER_EFFECTS_LIMITS.volumetricDistance, 1, hints.volumetricDistance)}
          {number(["volumetricLighting", "anisotropy"], "volumetric-anisotropy", "Scattering Anisotropy",
            RENDER_EFFECTS_LIMITS.volumetricAnisotropy, 0.01, hints.volumetricAnisotropy)}
          {number(["volumetricLighting", "resolutionScale"], "volumetric-scale", "Volumetric Resolution Scale",
            RENDER_EFFECTS_LIMITS.spatialResolutionScale, 0.25, hints.spatialScale)}
          {number(["volumetricLighting", "steps"], "volumetric-steps", "Volumetric Steps", RENDER_EFFECTS_LIMITS.volumetricSteps, 1)}
          {number(["volumetricLighting", "maxLights"], "volumetric-lights", "Volumetric Light Limit",
            RENDER_EFFECTS_LIMITS.volumetricLights, 1, hints.volumetricLights)}
        </FieldGroup>
      </FieldSet>
    </FieldGroup>
  );
}

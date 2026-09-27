import { NumberField } from "@babylonslate/editor-kit";
import {
  RENDER_EFFECTS_LIMITS,
  type RenderEffectsSettings,
} from "@babylonslate/core";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Switch } from "@babylonslate/ui/components/switch";

type Props = {
  value: RenderEffectsSettings;
  onChange(value: RenderEffectsSettings): void;
};

export function SpatialEffectsFields({ value, onChange }: Props) {
  const reflection = value.reflections,
    volume = value.volumetricLighting;
  const patchReflection = (patch: Partial<typeof reflection>) =>
    onChange({ ...value, reflections: { ...reflection, ...patch } });
  const patchVolume = (patch: Partial<typeof volume>) =>
    onChange({ ...value, volumetricLighting: { ...volume, ...patch } });
  const number = (
    label: string,
    suffix: string,
    current: number,
    limits: readonly [number, number],
    change: (v: number) => void,
    step = 0.01,
    description?: string,
  ) => {
    const id = `project-effects-${suffix}`;
    return (
      <Field key={id} className="settings-field">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <NumberField
          id={id}
          data-testid={id}
          value={current}
          min={limits[0]}
          max={limits[1]}
          step={step}
          onChange={change}
          aria-describedby={description ? `${id}-description` : undefined}
        />
        {description ? (
          <FieldDescription id={`${id}-description`}>
            {description}
          </FieldDescription>
        ) : null}
      </Field>
    );
  };
  return (
    <FieldGroup className="gap-2">
      <Field orientation="horizontal" className="settings-field">
        <FieldContent>
          <FieldLabel htmlFor="project-effects-reflections">
            Real-Time Reflections
          </FieldLabel>
          <FieldDescription>
            Reflect visible scene objects on PBR surfaces. Environment lighting
            remains available outside the view.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="project-effects-reflections"
          data-testid="project-effects-reflections"
          checked={reflection.enabled}
          onCheckedChange={(enabled) => patchReflection({ enabled })}
        />
      </Field>
      {reflection.enabled ? (
        <>
          {number(
            "Reflection Resolution Scale",
            "reflection-scale",
            reflection.resolutionScale,
            RENDER_EFFECTS_LIMITS.spatialResolutionScale,
            (resolutionScale) => patchReflection({ resolutionScale }),
            0.25,
          )}
          {number(
            "Reflection Steps",
            "reflection-steps",
            reflection.maxSteps,
            RENDER_EFFECTS_LIMITS.reflectionSteps,
            (maxSteps) => patchReflection({ maxSteps }),
            1,
          )}
          {number(
            "Reflection Distance",
            "reflection-distance",
            reflection.maxDistance,
            RENDER_EFFECTS_LIMITS.reflectionDistance,
            (maxDistance) => patchReflection({ maxDistance }),
            1,
          )}
          {number(
            "Reflection Thickness",
            "reflection-thickness",
            reflection.thickness,
            RENDER_EFFECTS_LIMITS.reflectionThickness,
            (thickness) => patchReflection({ thickness }),
          )}
          {number(
            "Reflection Strength",
            "reflection-strength",
            reflection.strength,
            RENDER_EFFECTS_LIMITS.reflectionStrength,
            (strength) => patchReflection({ strength }),
          )}
        </>
      ) : null}
      <FieldSet className="gap-2">
        <FieldLegend>Volumetric Fog</FieldLegend>
        <FieldGroup className="gap-2">
          <Field orientation="horizontal" className="settings-field">
            <FieldContent>
              <FieldLabel htmlFor="project-effects-volumetric">
                Scene-Wide Fog
              </FieldLabel>
              <FieldDescription>
                Fog lit by directional, point and spot lights. Light colors tint the
                fog; enable light shadows for occluded beams. Fog Volumes work with
                this off. The controls below tune both local and scene-wide fog.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="project-effects-volumetric"
              data-testid="project-effects-volumetric"
              checked={volume.enabled}
              onCheckedChange={(enabled) => patchVolume({ enabled })}
            />
          </Field>
          {volume.enabled ? number(
            "Scene-Wide Fog Density",
            "volumetric-density",
            volume.density,
            RENDER_EFFECTS_LIMITS.volumetricDensity,
            (density) => patchVolume({ density }),
            0.001,
            "Uniform fog thickness per scene unit. Zero removes scene-wide haze while Fog Volumes still contribute.",
          ) : null}
          {number(
            "Volumetric Intensity",
            "volumetric-intensity",
            volume.intensity,
            RENDER_EFFECTS_LIMITS.volumetricIntensity,
            (intensity) => patchVolume({ intensity }),
            0.01,
            "Brightness of scattered light. Zero removes light beams but keeps fog darkening.",
          )}
          {number(
            "Volumetric Distance",
            "volumetric-distance",
            volume.maxDistance,
            RENDER_EFFECTS_LIMITS.volumetricDistance,
            (maxDistance) => patchVolume({ maxDistance }),
            1,
            "Maximum distance sampled from the camera, in scene units. Scene surfaces stop the fog ray earlier.",
          )}
          {number(
            "Scattering Anisotropy",
            "volumetric-anisotropy",
            volume.anisotropy,
            RENDER_EFFECTS_LIMITS.volumetricAnisotropy,
            (anisotropy) => patchVolume({ anisotropy }),
            0.01,
            "Zero scatters evenly. Positive values strengthen beams when looking toward a light; negative values favor the opposite view.",
          )}
          {number(
            "Volumetric Resolution Scale",
            "volumetric-scale",
            volume.resolutionScale,
            RENDER_EFFECTS_LIMITS.spatialResolutionScale,
            (resolutionScale) => patchVolume({ resolutionScale }),
            0.25,
            "Multiplies Post Processing Resolution Scale, with a quarter-resolution minimum. Lower values reduce cost and soften detail.",
          )}
          {number(
            "Volumetric Steps",
            "volumetric-steps",
            volume.steps,
            RENDER_EFFECTS_LIMITS.volumetricSteps,
            (steps) => patchVolume({ steps }),
            1,
            "More samples reduce banding, especially over long distances, at a higher rendering cost.",
          )}
          {number(
            "Volumetric Light Limit",
            "volumetric-lights",
            volume.maxLights,
            RENDER_EFFECTS_LIMITS.volumetricLights,
            (maxLights) => patchVolume({ maxLights }),
            1,
            "Maximum contributing lights. Lower values reduce cost; hemispheric fill and area lights do not contribute.",
          )}
        </FieldGroup>
      </FieldSet>
    </FieldGroup>
  );
}

import type { ReactNode } from "react";
import {
  ENVIRONMENT_LIGHTING_LIMITS,
  normalizeEnvironmentLightingSettings,
  resolveEnvironmentLightingSettings,
  type EnvironmentLightingOverrides,
  type EnvironmentLightingSettings,
} from "@babylonslate/core";
import { NumberField } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";

const fields = [
  {
    key: "enabled",
    label: "Image-Based Lighting",
    description:
      "Light surfaces with the Scene's prefiltered environment texture.",
  },
  {
    key: "intensity",
    label: "Environment Intensity",
    description:
      "Scale automatic environment lighting. Explicit Environment Sample nodes return the original linear radiance.",
  },
  {
    key: "rotationYDegrees",
    label: "Environment Rotation",
    description: "Rotate the environment around world Y, in degrees.",
  },
  {
    key: "celStrength",
    label: "CEL Environment Strength",
    description:
      "Feed diffuse environment light into CEL bands. Zero preserves direct-light-only CEL shading.",
  },
] as const;

export const ENVIRONMENT_LIGHTING_SEARCH_TEXT = [
  "Environment Lighting Texture IBL",
  ...fields.map(({ label, description }) => `${label} ${description}`),
].join(" ");

/** Shared compact fields; Scene overrides remain sparse and independently reset. */
export function EnvironmentLightingFields({
  project,
  overrides,
  onChange,
  hideTitle = false,
  cel = false,
  children,
}: {
  project?: EnvironmentLightingSettings;
  overrides?: EnvironmentLightingOverrides;
  onChange: (settings: EnvironmentLightingOverrides) => void;
  hideTitle?: boolean;
  cel?: boolean;
  children?: ReactNode;
}) {
  const scene = overrides !== undefined;
  const defaults = normalizeEnvironmentLightingSettings(project);
  const effective = resolveEnvironmentLightingSettings(defaults, overrides);
  const patch = (
    key: keyof EnvironmentLightingSettings,
    value: boolean | number,
  ) => onChange({ ...(scene ? overrides : defaults), [key]: value });
  return (
    <FieldSet
      data-testid={
        scene ? "scene-environment-lighting" : "project-environment-lighting"
      }
    >
      <FieldLegend className={hideTitle ? "sr-only" : undefined}>
        Environment Lighting
      </FieldLegend>
      <FieldGroup className="gap-2">
        {fields.map(({ key, label, description }) => {
          if (key !== "enabled" && !effective.enabled) return null;
          if (key === "celStrength" && !cel) return null;
          const id = `${scene ? "scene" : "project"}-environment-${key}`;
          const overridden = scene && Object.hasOwn(overrides, key);
          const disabled = scene && !overridden;
          return (
            <Field
              key={key}
              className="settings-field"
              data-disabled={disabled || undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                {scene ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`${overridden ? "Reset" : "Override"} ${label}`}
                    onClick={() => {
                      if (!overridden) {
                        patch(key, effective[key]);
                        return;
                      }
                      const next = { ...overrides };
                      delete next[key];
                      onChange(next);
                    }}
                  >
                    {overridden ? "Reset To Project" : "Override"}
                  </Button>
                ) : null}
              </div>
              {key === "enabled" ? (
                <Switch
                  id={id}
                  checked={effective.enabled}
                  disabled={disabled}
                  aria-describedby={`${id}-description`}
                  onCheckedChange={(value) => patch(key, value)}
                />
              ) : (
                <NumberField
                  id={id}
                  value={effective[key]}
                  disabled={disabled}
                  min={ENVIRONMENT_LIGHTING_LIMITS[key][0]}
                  max={ENVIRONMENT_LIGHTING_LIMITS[key][1]}
                  step={key === "rotationYDegrees" ? 1 : 0.01}
                  aria-describedby={`${id}-description`}
                  onChange={(value) => patch(key, value)}
                />
              )}
              <FieldDescription id={`${id}-description`}>
                {scene
                  ? `${overridden ? "Scene Override · Project" : "Project Setting"}: ${String(defaults[key])}. `
                  : ""}
                {description}
              </FieldDescription>
            </Field>
          );
        })}
        {effective.enabled ? children : null}
      </FieldGroup>
    </FieldSet>
  );
}

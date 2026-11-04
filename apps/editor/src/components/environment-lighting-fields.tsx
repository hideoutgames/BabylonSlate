import type { ReactNode } from "react";
import {
  ENVIRONMENT_LIGHTING_LIMITS,
  normalizeEnvironmentLightingSettings,
  resolveEnvironmentLightingSettings,
  type EnvironmentLightingOverrides,
  type EnvironmentLightingSettings,
} from "@haptic/core";
import { LabelHint, NumberField } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Switch } from "@haptic/ui/components/switch";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@haptic/ui/components/field";

/** `hint` is the label's tooltip and the control's screen-reader description. */
const fields = [
  {
    key: "enabled",
    label: "Image-Based Lighting",
    hint: "Lights surfaces with the Scene's prefiltered environment texture.",
  },
  {
    key: "intensity",
    label: "Environment Intensity",
    hint: "Scales automatic environment lighting. Environment Sample nodes are unaffected.",
  },
  {
    key: "rotationYDegrees",
    label: "Environment Rotation",
    hint: "Rotation around world Y, in degrees.",
  },
  {
    key: "celStrength",
    label: "CEL Environment Strength",
    hint: "Adds diffuse environment light to CEL bands. Zero uses direct light only.",
  },
] as const;

export const ENVIRONMENT_LIGHTING_SEARCH_TEXT = [
  "Environment Lighting Environment Source None Skybox Environment Texture IBL",
  ...fields.map(({ label, hint }) => `${label} ${hint}`),
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
        {fields.map(({ key, label, hint }) => {
          if (key !== "enabled" && !effective.enabled) return null;
          if (key === "celStrength" && !cel) return null;
          const id = `${scene ? "scene" : "project"}-environment-${key}`;
          const overridden = scene && Object.hasOwn(overrides, key);
          const disabled = scene && !overridden;
          // A scene row shows the project value it inherits or overrides, as its control shows it.
          const projectValue = defaults[key];
          const shown = typeof projectValue === "boolean" ? (projectValue ? "On" : "Off") : String(projectValue);
          const status = scene ? `${overridden ? "Scene Override · Project" : "Project Setting"}: ${shown}.` : "";
          const describedBy = status ? `${id}-description ${id}-status` : `${id}-description`;
          return (
            <Field
              key={key}
              className="settings-field"
              data-disabled={disabled || undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <LabelHint hint={hint}>
                  <FieldLabel htmlFor={id}>{label}</FieldLabel>
                </LabelHint>
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
                  aria-describedby={describedBy}
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
                  aria-describedby={describedBy}
                  onChange={(value) => patch(key, value)}
                />
              )}
              <FieldDescription id={`${id}-description`} className="sr-only">{hint}</FieldDescription>
              {status ? <FieldDescription id={`${id}-status`}>{status}</FieldDescription> : null}
            </Field>
          );
        })}
        {effective.enabled ? children : null}
      </FieldGroup>
    </FieldSet>
  );
}

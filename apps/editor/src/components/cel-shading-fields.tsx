import {
  CEL_SHADING_LIMITS,
  resolveCelShadingSettings,
  type CelShadingOverrides,
  type CelShadingSettings,
} from "@babylonslate/core";
import { NumberField } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";

const lightMixingLabels = {
  strongest: "Strongest Light",
  additive: "Additive",
  blend: "Blend",
} as const;

const fields: {
  key: keyof CelShadingSettings;
  label: string;
  description: string;
}[] = [
  {
    key: "lightMixing",
    label: "Light Mixing",
    description:
      "Strongest Light keeps the dominant light's color. Additive sums lighting. Blend mixes colors at the strongest light's brightness.",
  },
  {
    key: "shadowBands",
    label: "Shadow Bands",
    description: "Number of light and shade levels.",
  },
  {
    key: "shadowThreshold",
    label: "Shadow Threshold",
    description: "Higher values extend the shaded region.",
  },
  {
    key: "bandSoftness",
    label: "Band Softness",
    description: "Softens transitions between bands. Zero gives hard edges.",
  },
  {
    key: "shadowStrength",
    label: "Shadow Strength",
    description: "Darkness of the deepest shade and cast shadows.",
  },
  {
    key: "specularStrength",
    label: "Specular Strength",
    description: "Highlight intensity. Zero disables highlights.",
  },
  {
    key: "specularSize",
    label: "Specular Size",
    description: "Size of the stylized highlight.",
  },
  {
    key: "specularSoftness",
    label: "Specular Softness",
    description: "Softness of the highlight edge.",
  },
  {
    key: "lightColorInfluence",
    label: "Light Color Influence",
    description:
      "Colored light tint. Zero uses neutral light with the same intensity.",
  },
];

type Props = {
  project: CelShadingSettings;
  /** Omit for project authoring; an empty object means scene inheritance. */
  overrides?: CelShadingOverrides;
  onChange: (value: CelShadingOverrides) => void;
};

/** The same controls author project defaults and individual scene overrides. */
export function CelShadingFields({ project, overrides, onChange }: Props) {
  const scene = overrides !== undefined;
  const effective = resolveCelShadingSettings(project, overrides);
  const patch = (key: keyof CelShadingSettings, value: number | string) =>
    onChange({ ...(scene ? overrides : project), [key]: value });
  return (
    <FieldSet
      data-testid={scene ? "scene-cel-settings" : "project-cel-settings"}
    >
      <FieldLegend>CEL Shading</FieldLegend>
      <FieldGroup className="gap-2">
        {fields.map(({ key, label, description }) => {
          const id = `${scene ? "scene" : "project"}-cel-${key}`;
          const overridden = scene && Object.hasOwn(overrides, key);
          return (
            <Field key={key} className="settings-field">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                {scene ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`${overridden ? "Reset" : "Override"} ${label}${overridden ? " To Project Settings" : ""}`}
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
              {key === "lightMixing" ? (
                <Select
                  value={effective.lightMixing}
                  disabled={scene && !overridden}
                  onValueChange={(value) => {
                    if (value) patch(key, value);
                  }}
                >
                  <SelectTrigger id={id} aria-describedby={`${id}-description`}>
                    <SelectValue>
                      {lightMixingLabels[effective.lightMixing]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {Object.entries(lightMixingLabels).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <NumberField
                  key={
                    scene
                      ? `${key}-${overridden ? "override" : "project"}`
                      : key
                  }
                  id={id}
                  aria-describedby={`${id}-description`}
                  value={effective[key]}
                  min={CEL_SHADING_LIMITS[key][0]}
                  max={CEL_SHADING_LIMITS[key][1]}
                  step={key === "shadowBands" ? 1 : 0.01}
                  disabled={scene && !overridden}
                  onChange={(value) => patch(key, value)}
                />
              )}
              <FieldDescription id={`${id}-description`}>
                {scene
                  ? `${overridden ? "Scene Override · Project" : "Project Setting"}: ${key === "lightMixing" ? lightMixingLabels[project[key]] : project[key]}. `
                  : ""}
                {description}
              </FieldDescription>
            </Field>
          );
        })}
      </FieldGroup>
    </FieldSet>
  );
}

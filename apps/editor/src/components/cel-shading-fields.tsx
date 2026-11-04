import {
  CEL_SHADING_LIMITS,
  resolveCelShadingSettings,
  type CelShadingOverrides,
  type CelShadingSettings,
} from "@haptic/core";
import { ColorField, colorToHex, LabelHint, NumberField } from "@haptic/editor-kit";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";

const lightMixingLabels = {
  strongest: "Strongest Light",
  additive: "Additive",
  blend: "Blend",
} as const;

const switchKeys = [
  "outlinesEnabled",
  "outlineDistanceFadeEnabled",
  "specularEnabled",
] as const;
type SwitchKey = (typeof switchKeys)[number];
const isSwitch = (key: keyof CelShadingSettings): key is SwitchKey => (switchKeys as readonly string[]).includes(key);

/** `hint` is the label's tooltip and the control's screen-reader description. */
const fields: {
  key: keyof CelShadingSettings;
  label: string;
  hint?: string;
}[] = [
  {
    key: "outlinesEnabled",
    label: "Outlines",
    hint: "Outlines eligible scene geometry. Other geometry hides them.",
  },
  {
    key: "outlineColor",
    label: "Outline Color",
    hint: "Default silhouette color. Outline components use their own.",
  },
  {
    key: "outlineWidth",
    label: "Outline Width",
    hint: "Default silhouette width in output pixels.",
  },
  {
    key: "outlineDistanceFadeEnabled",
    label: "Outline Distance Fade",
    hint: "Shrinks outlines to zero with distance. Outline components keep their own style.",
  },
  {
    key: "outlineFadeStart",
    label: "Outline Fade Start",
    hint: "Camera distance in scene units where outlines begin shrinking.",
  },
  {
    key: "outlineFadeEnd",
    label: "Outline Fade End",
    hint: "Camera distance in scene units where outlines reach zero width. Must be greater than Fade Start.",
  },
  {
    key: "lightMixing",
    label: "Light Mixing",
    hint: "Strongest Light keeps the dominant light's color. Additive sums lighting. Blend mixes colors at the strongest light's brightness.",
  },
  {
    key: "shadowBands",
    label: "Shadow Bands",
    hint: "Number of light and shade levels.",
  },
  {
    key: "shadowThreshold",
    label: "Shadow Threshold",
    hint: "Higher values extend the shaded region.",
  },
  {
    key: "shadowStrength",
    label: "Shadow Strength",
    hint: "Darkness of the deepest shade and cast shadows.",
  },
  { key: "specularEnabled", label: "Specular" },
  {
    key: "specularStrength",
    label: "Specular Strength",
    hint: "Zero disables highlights.",
  },
  { key: "specularSize", label: "Specular Size" },
  {
    key: "lightColorInfluence",
    label: "Light Color Influence",
    hint: "Colored light tint. Zero uses neutral light with the same intensity.",
  },
];

/** Every row label, option and hint, for the Scene Inspector's property filter. */
export const CEL_SHADING_SEARCH_TEXT = [
  ...fields.flatMap(({ label, hint }) => (hint ? [label, hint] : [label])),
  ...Object.values(lightMixingLabels),
].join(" ");

type Props = {
  project: CelShadingSettings;
  /** Omit for project authoring; an empty object means scene inheritance. */
  overrides?: CelShadingOverrides;
  onChange: (value: CelShadingOverrides) => void;
  hideTitle?: boolean;
};

/** The same controls author project defaults and individual scene overrides. */
export function CelShadingFields({ project, overrides, onChange, hideTitle = false }: Props) {
  const scene = overrides !== undefined;
  const effective = resolveCelShadingSettings(project, overrides);
  const patch = (key: keyof CelShadingSettings, value: CelShadingSettings[keyof CelShadingSettings]) =>
    onChange({ ...(scene ? overrides : project), [key]: value });
  return (
    <FieldSet
      data-testid={scene ? "scene-cel-settings" : "project-cel-settings"}
    >
      <FieldLegend className={hideTitle ? "sr-only" : undefined}>CEL Shading</FieldLegend>
      <FieldGroup className="gap-2">
        {fields.map(({ key, label, hint }) => {
          const id = `${scene ? "scene" : "project"}-cel-${key}`;
          const overridden = scene && Object.hasOwn(overrides, key);
          // A scene row shows the project value it inherits or overrides.
          const status = scene
            ? `${overridden ? "Scene Override · Project" : "Project Setting"}: ${key === "lightMixing" ? lightMixingLabels[project[key]] : isSwitch(key) ? project[key] ? "On" : "Off" : key === "outlineColor" ? colorToHex(project[key]) : project[key]}.`
            : "";
          const describedBy = [hint ? `${id}-description` : "", status ? `${id}-status` : ""].filter(Boolean).join(" ") || undefined;
          const fieldLabel = <FieldLabel htmlFor={id}>{label}</FieldLabel>;
          return (
            <Field key={key} className="settings-field">
              <div className="flex items-center justify-between gap-2">
                {hint ? <LabelHint hint={hint}>{fieldLabel}</LabelHint> : fieldLabel}
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
              {isSwitch(key) ? (
                <Switch
                  id={id}
                  aria-describedby={describedBy}
                  checked={effective[key]}
                  disabled={scene && !overridden}
                  onCheckedChange={(value) => patch(key, value)}
                />
              ) : key === "lightMixing" ? (
                <Select
                  value={effective.lightMixing}
                  disabled={scene && !overridden}
                  onValueChange={(value) => {
                    if (value === "strongest" || value === "additive" || value === "blend") patch(key, value);
                  }}
                >
                  <SelectTrigger id={id} aria-describedby={describedBy}>
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
              ) : key === "outlineColor" ? (
                <ColorField
                  key={`${key}-${overridden ? "override" : "project"}`}
                  id={id}
                  aria-label={label}
                  value={effective.outlineColor}
                  disabled={scene && !overridden}
                  onChange={(value) => patch(key, value)}
                />
              ) : (
                <NumberField
                  key={
                    scene
                      ? `${key}-${overridden ? "override" : "project"}`
                      : key
                  }
                  id={id}
                  aria-describedby={describedBy}
                  value={effective[key]}
                  min={CEL_SHADING_LIMITS[key][0]}
                  max={CEL_SHADING_LIMITS[key][1]}
                  step={key === "shadowBands" || key === "outlineFadeStart" || key === "outlineFadeEnd" ? 1 : 0.01}
                  disabled={scene && !overridden}
                  onChange={(value) => patch(key, value)}
                />
              )}
              {hint ? (
                <FieldDescription id={`${id}-description`} className="sr-only">{hint}</FieldDescription>
              ) : null}
              {status ? <FieldDescription id={`${id}-status`}>{status}</FieldDescription> : null}
            </Field>
          );
        })}
      </FieldGroup>
    </FieldSet>
  );
}

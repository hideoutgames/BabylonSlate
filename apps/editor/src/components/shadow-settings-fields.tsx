import {
  normalizeShadowSettings,
  resolveShadowSettings,
  SHADOW_LIMITS,
  SHADOW_PROFILES,
  type ShadowOverrides,
  type ShadowSettings,
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";

const options: Partial<Record<keyof ShadowSettings, Record<string, string>>> = {
  profile: {
    low: "Low",
    medium: "Medium",
    high: "High",
    ultra: "Ultra",
  },
  filter: { pcf: "PCF", pcss: "Contact Hardening (PCSS)" },
  filterQuality: { low: "Low", medium: "Medium", high: "High" },
  mapSize: { 256: "256", 512: "512", 1024: "1024", 2048: "2048", 4096: "4096" },
  localMapSize: { 256: "256", 512: "512", 1024: "1024", 2048: "2048", 4096: "4096" },
};
const fields: {
  key: keyof ShadowSettings;
  label: string;
  description: string;
}[] = [
  {
    key: "enabled",
    label: "Shadows Enabled",
    description: "Allow eligible lights to cast real-time shadows.",
  },
  {
    key: "profile",
    label: "Shadow Preset",
    description:
      "Apply map resolution, cascade and filtering defaults. Preserve the shadow distance and local light budget.",
  },
  {
    key: "distance",
    label: "Shadow Distance",
    description:
      "Camera-relative directional shadow coverage in world units. Does not limit scene size.",
  },
  {
    key: "fadeFraction",
    label: "Shadow Distance Fade",
    description:
      "Fraction of the directional shadow distance used to fade the far cutoff. Zero disables fading.",
  },
  {
    key: "mapSize",
    label: "Directional Map Size",
    description:
      "Resolution per cascade. Larger maps use more GPU memory and time.",
  },
  {
    key: "cascades",
    label: "Shadow Cascades",
    description: "Split directional coverage to retain detail near the camera.",
  },
  {
    key: "filter",
    label: "Shadow Filter",
    description:
      "PCF filters shadow edges. PCSS adds distance-dependent penumbra in PBR. CEL uses PCF; point lights use the supported cube-map filter.",
  },
  {
    key: "filterQuality",
    label: "Shadow Filter Quality",
    description: "Higher quality uses more texture samples.",
  },
  {
    key: "softness",
    label: "Contact Hardening Size",
    description: "PBR PCSS light size; larger values widen the penumbra.",
  },
  {
    key: "depthBias",
    label: "Shadow Depth Bias",
    description:
      "Advanced depth offset. Excessive values detach shadows from surfaces.",
  },
  {
    key: "autoBias",
    label: "Automatic Shadow Bias",
    description:
      "Calibrate directional cascade bias from texel size and filter footprint, using the authored depth and normal offsets as minimums. Disable for manual offsets.",
  },
  {
    key: "normalBias",
    label: "Shadow Normal Bias",
    description: "Advanced geometric normal offset in world units.",
  },
  {
    key: "maxLocalLights",
    label: "Local Shadow Light Budget",
    description:
      "Maximum simultaneous point and spot shadow lights. A point light renders six faces.",
  },
  {
    key: "localMapSize",
    label: "Local Shadow Map Size",
    description: "Resolution for each local light map or cube face.",
  },
];

export function ShadowSettingsFields({
  project,
  overrides,
  onChange,
}: {
  project?: ShadowSettings;
  overrides?: ShadowOverrides;
  onChange: (value: ShadowOverrides) => void;
}) {
  const scene = overrides !== undefined;
  const defaults = normalizeShadowSettings(project);
  const effective = resolveShadowSettings(defaults, overrides);
  const patch = (
    key: keyof ShadowSettings,
    value: string | number | boolean,
  ) => {
    const preset =
      key === "profile"
        ? SHADOW_PROFILES[value as keyof typeof SHADOW_PROFILES]
        : {};
    onChange({ ...(scene ? overrides : defaults), ...preset, [key]: value });
  };
  return (
    <FieldSet
      data-testid={scene ? "scene-shadow-settings" : "project-shadow-settings"}
    >
      <FieldLegend>Shadows</FieldLegend>
      <FieldGroup className="gap-2">
        {fields
          .filter(({ key }) => key !== "profile")
          .map(({ key, label, description }) => {
            const id = `${scene ? "scene" : "project"}-shadow-${key}`;
            const overridden = scene && Object.hasOwn(overrides, key);
            const choices = options[key];
            const limits =
              key in SHADOW_LIMITS
                ? SHADOW_LIMITS[key as keyof typeof SHADOW_LIMITS]
                : [0, 2048];
            return (
              <Field key={key} className="settings-field">
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
                {key === "enabled" || key === "autoBias" ? (
                  <Switch
                    id={id}
                    checked={effective[key]}
                    disabled={scene && !overridden}
                    onCheckedChange={(value) => patch(key, value)}
                  />
                ) : choices ? (
                  <Select
                    value={String(effective[key])}
                    disabled={scene && !overridden}
                    onValueChange={(value) => {
                      if (value)
                        patch(
                          key,
                          typeof effective[key] === "number"
                            ? Number(value)
                            : value,
                        );
                    }}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue>
                        {choices[String(effective[key])]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.entries(choices).map(([value, name]) => (
                          <SelectItem key={value} value={value}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <NumberField
                    id={id}
                    value={Number(effective[key])}
                    min={limits[0]}
                    max={limits[1]}
                    step={
                      key === "distance" ||
                      key === "cascades" ||
                      key === "maxLocalLights"
                        ? 1
                        : 0.0001
                    }
                    disabled={scene && !overridden}
                    onChange={(value) => patch(key, value)}
                  />
                )}
                <FieldDescription>
                  {scene
                    ? `${overridden ? "Scene Override · Project" : "Project Setting"}: ${String(defaults[key])}. `
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

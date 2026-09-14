import {
  normalizeShadowSettings,
  resolveShadowSettings,
  SHADOW_LIMITS,
  SHADOW_CAPACITY_PROFILES,
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
  localLightMode: { auto: "Auto", manual: "Manual" },
  filter: { pcf: "PCF", pcss: "Contact Hardening (PCSS)" },
  filterQuality: { low: "Low", medium: "Medium", high: "High" },
  mapSize: { 256: "256", 512: "512", 1024: "1024", 2048: "2048", 4096: "4096" },
  localMapSize: {
    256: "256",
    512: "512",
    1024: "1024",
    2048: "2048",
    4096: "4096",
  },
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
    key: "localLightMode",
    label: "Local Shadow Budget Mode",
    description:
      "Auto selects local shadow capacity from the quality tier. Manual sets an authored upper limit within the effective device budget.",
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

export const SHADOW_SETTINGS_SEARCH_TEXT = [
  "Shadows Post Processing Auto Manual",
  ...fields.map(({ label, description }) => `${label} ${description}`),
].join(" ");

export function ShadowSettingsFields({
  project,
  overrides,
  onChange,
  hideTitle = false,
}: {
  project?: ShadowSettings;
  overrides?: ShadowOverrides;
  onChange: (value: ShadowOverrides) => void;
  hideTitle?: boolean;
}) {
  const scene = overrides !== undefined;
  const defaults = normalizeShadowSettings(project);
  const effective = resolveShadowSettings(defaults, overrides);
  const patch = (
    key: keyof ShadowSettings,
    value: string | number | boolean,
    selectManual = false,
  ) => {
    onChange({
      ...(scene ? overrides : defaults),
      [key]: value,
      ...(selectManual ? { localLightMode: "manual" as const } : {}),
      ...(!scene ? { preset: "custom" as const } : {}),
    });
  };
  return (
    <FieldSet
      data-testid={scene ? "scene-shadow-settings" : "project-shadow-settings"}
    >
      <FieldLegend className={hideTitle ? "sr-only" : undefined}>
        Shadows
      </FieldLegend>
      <FieldGroup className="gap-2">
        {fields.map(({ key, label, description }) => {
          if (key !== "enabled" && !effective.enabled) return null;
          if (key === "maxLocalLights" && effective.localLightMode !== "manual")
            return null;
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
                  aria-describedby={`${id}-description`}
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
                  <SelectTrigger id={id} aria-describedby={`${id}-description`}>
                    <SelectValue>{choices[String(effective[key])]}</SelectValue>
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
                  aria-describedby={`${id}-description`}
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
                  onChange={(value) =>
                    patch(key, value, key === "maxLocalLights")
                  }
                />
              )}
              <FieldDescription id={`${id}-description`}>
                {scene
                  ? `${overridden ? "Scene Override · Project" : "Project Setting"}: ${String(defaults[key])}. `
                  : ""}
                {description}
                {key === "localLightMode" && effective.localLightMode === "auto"
                  ? ` Current Auto Budget: ${SHADOW_CAPACITY_PROFILES[effective.profile].autoLocalLights} local shadow lights. Applying a quality preset resets the saved Manual count to that tier.`
                  : ""}
              </FieldDescription>
            </Field>
          );
        })}
      </FieldGroup>
    </FieldSet>
  );
}

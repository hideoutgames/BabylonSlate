import {
  normalizeShadowSettings,
  resolveShadowSettings,
  SHADOW_LIMITS,
  SHADOW_CAPACITY_PROFILES,
  type ShadowOverrides,
  type ShadowSettings,
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";

const options: Partial<Record<keyof ShadowSettings, Record<string, string>>> = {
  localLightMode: { auto: "Auto", manual: "Manual" },
  filter: { pcf: "PCF", pcss: "Contact Hardening (PCSS)" },
  filterQuality: { low: "Low", medium: "Medium", high: "High" },
  screenShadows: { off: "Off", low: "Low", medium: "Medium", high: "High" },
  mapSize: { 256: "256", 512: "512", 1024: "1024", 2048: "2048", 4096: "4096", 8192: "8192" },
  localMapSize: {
    256: "256",
    512: "512",
    1024: "1024",
    2048: "2048",
    4096: "4096",
  },
};
/** `hint` is the label's tooltip and the control's screen-reader description. */
const fields: {
  key: Exclude<keyof ShadowSettings, "profile" | "preset">;
  label: string;
  hint?: string;
}[] = [
  { key: "enabled", label: "Shadows Enabled" },
  {
    key: "distance",
    label: "Shadow Distance",
    hint: "Directional shadow coverage around the camera, in world units.",
  },
  {
    key: "fadeFraction",
    label: "Shadow Distance Fade",
    hint: "Fades the far edge over this fraction of the distance. Zero disables fading.",
  },
  {
    key: "mapSize",
    label: "Directional Map Size",
    hint: "Resolution per cascade. Larger maps use more GPU memory and time; 8192 needs a 1 GiB shadow atlas.",
  },
  {
    key: "cascades",
    label: "Shadow Cascades",
    hint: "Splits directional coverage to keep detail near the camera.",
  },
  {
    key: "filter",
    label: "Shadow Filter",
    hint: "PCF softens edges. PCSS adds contact-hardening penumbra in PBR. CEL always uses PCF.",
  },
  { key: "filterQuality", label: "Shadow Filter Quality" },
  {
    key: "softness",
    label: "Contact Hardening Size",
    hint: "PCSS light size. Larger values widen the penumbra.",
  },
  {
    key: "screenShadows",
    label: "Screen-Space Shadows",
    hint: "Adds the sun's small contact shadows the shadow map misses, near the camera. Uses a depth pass. PBR only.",
  },
  {
    key: "depthBias",
    label: "Shadow Depth Bias",
    hint: "High values detach shadows from surfaces.",
  },
  {
    key: "autoBias",
    label: "Automatic Shadow Bias",
    hint: "Scales directional bias per cascade, with Depth Bias as the minimum. Turn off for manual offsets.",
  },
  {
    key: "normalBias",
    label: "Shadow Normal Bias",
    hint: "Normal offset in world units.",
  },
  {
    key: "localLightMode",
    label: "Local Shadow Budget Mode",
    hint: "Auto follows the quality tier; Manual sets an upper limit within the device budget. Applying a quality preset resets the saved Manual count.",
  },
  {
    key: "maxLocalLights",
    label: "Local Shadow Light Budget",
    hint: "Point and spot lights that can cast shadows at once. A point light renders six faces.",
  },
  {
    key: "localMapSize",
    label: "Local Shadow Map Size",
    hint: "Resolution for each local light map or cube face.",
  },
];

export const SHADOW_SETTINGS_SEARCH_TEXT = [
  "Shadows Post Processing Auto Manual",
  ...fields.map(({ label, hint }) => (hint ? `${label} ${hint}` : label)),
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
        {fields.map(({ key, label, hint }) => {
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
          // Live state stays visible: the project value behind a scene row, as its control shows it, and the current Auto budget.
          const projectValue = defaults[key];
          const shown = choices ? choices[String(projectValue)] ?? String(projectValue)
            : typeof projectValue === "boolean" ? (projectValue ? "On" : "Off") : String(projectValue);
          const status = [
            scene ? `${overridden ? "Scene Override · Project" : "Project Setting"}: ${shown}.` : "",
            key === "localLightMode" && effective.localLightMode === "auto"
              ? `Current Auto Budget: ${SHADOW_CAPACITY_PROFILES[effective.profile].autoLocalLights} local shadow lights.`
              : "",
          ].filter(Boolean).join(" ");
          const describedBy = [hint ? `${id}-description` : "", status ? `${id}-status` : ""].filter(Boolean).join(" ") || undefined;
          const fieldLabel = <FieldLabel htmlFor={id}>{label}</FieldLabel>;
          return (
            <Field key={key} className={key === "maxLocalLights" ? "settings-field settings-field-dependent" : "settings-field"}>
              <div className="flex items-center justify-between gap-2">
                {hint ? <LabelHint hint={hint}>{fieldLabel}</LabelHint> : fieldLabel}
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
                  aria-describedby={describedBy}
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
                  <SelectTrigger id={id} aria-describedby={describedBy}>
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
                  aria-describedby={describedBy}
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

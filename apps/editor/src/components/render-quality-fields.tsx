import {
  QUALITY_GROUPS,
  QUALITY_LEVELS,
  qualityGroupLabel,
  qualityPresetPatch,
  resolveRenderingQuality,
  applyProjectQualityPatch,
  qualitySettingPatch,
  QUALITY_TARGET_LABELS,
  resolveLocalLightBudget,
  type RenderProjectSettings,
  type QualityGroup,
  type QualityLevel,
} from "@babylonslate/core";
import { NumberField } from "@babylonslate/editor-kit";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldSet,
  FieldLegend,
} from "@babylonslate/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { Switch } from "@babylonslate/ui/components/switch";

const labels = {
  shadows: "Shadows",
  lighting: "Lighting",
  resolution: "Resolution",
  textures: "Textures",
  postprocessing: "Post Processing",
};
export function RenderQualityFields({
  settings,
  onChange,
}: {
  settings: RenderProjectSettings;
  onChange: (settings: RenderProjectSettings) => void;
}) {
  const effective = resolveRenderingQuality(settings);
  const apply = (level: QualityLevel, group?: QualityGroup) => {
    onChange(
      applyProjectQualityPatch(settings, qualityPresetPatch(level, group)),
    );
  };
  const edit = <G extends QualityGroup>(
    group: G,
    patch: Parameters<typeof qualitySettingPatch<G>>[1],
  ) =>
    onChange(
      applyProjectQualityPatch(settings, qualitySettingPatch(group, patch)),
    );
  const displayLabel = (value: string) =>
    value[0]!.toUpperCase() + value.slice(1);
  const groupLabels = QUALITY_GROUPS.map((group) =>
    qualityGroupLabel(effective, group),
  );
  const overall = groupLabels.every((value) => value === groupLabels[0])
    ? groupLabels[0]!
    : "custom";
  return (
    <FieldSet>
      <FieldLegend>Scalability</FieldLegend>
      {([undefined, ...QUALITY_GROUPS] as (QualityGroup | undefined)[]).map(
        (group) => (
          <Field key={group ?? "all"} className="settings-field">
            <FieldLabel htmlFor={`quality-${group ?? "all"}`}>
              {group ? `${labels[group]} Quality` : "Overall Quality"}
            </FieldLabel>
            <Select
              value={group ? qualityGroupLabel(effective, group) : overall}
              onValueChange={(value) => {
                if (value && value !== "custom")
                  apply(value as QualityLevel, group);
              }}
            >
              <SelectTrigger id={`quality-${group ?? "all"}`}>
                <SelectValue>
                  {displayLabel(
                    group ? qualityGroupLabel(effective, group) : overall,
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="custom" disabled>
                    Custom
                  </SelectItem>
                  {QUALITY_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level[0]!.toUpperCase() + level.slice(1)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {!group ? (
              <FieldDescription>
                Low targets a budget Android phone, Medium Apple A16, and Ultra
                a high-end gaming PC. These are unqualified targets; device
                admission can reduce effective cost.
              </FieldDescription>
            ) : null}
          </Field>
        ),
      )}
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-resolution-scale">
          Resolution Scale
        </FieldLabel>
        <NumberField
          id="quality-resolution-scale"
          value={effective.resolution.scale}
          min={0.25}
          max={1}
          step={0.05}
          onChange={(scale) => edit("resolution", { scale })}
        />
        <FieldDescription>
          Fraction of the target width and height. Runtime quality commands can
          override this for the session.
        </FieldDescription>
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-resolution-dynamic">
          Dynamic Resolution
        </FieldLabel>
        <Switch
          id="quality-resolution-dynamic"
          checked={effective.resolution.dynamic}
          onCheckedChange={(dynamic) => edit("resolution", { dynamic })}
        />
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-resolution-minimum">
          Minimum Resolution Scale
        </FieldLabel>
        <NumberField
          id="quality-resolution-minimum"
          value={effective.resolution.minScale}
          min={0.25}
          max={effective.resolution.scale}
          step={0.05}
          disabled={!effective.resolution.dynamic}
          onChange={(minScale) => edit("resolution", { minScale })}
        />
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-resolution-target">
          Dynamic Resolution Target FPS
        </FieldLabel>
        <NumberField
          id="quality-resolution-target"
          min={1}
          max={240}
          value={effective.resolution.targetFps}
          disabled={!effective.resolution.dynamic}
          onChange={(targetFps) => edit("resolution", { targetFps })}
        />
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-textures-lod">Texture LOD Bias</FieldLabel>
        <NumberField
          id="quality-textures-lod"
          min={0}
          max={8}
          value={effective.textures.lodBias}
          onChange={(lodBias) => edit("textures", { lodBias })}
        />
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-textures-anisotropy">
          Texture Anisotropy
        </FieldLabel>
        <NumberField
          id="quality-textures-anisotropy"
          min={1}
          max={16}
          value={effective.textures.anisotropy}
          onChange={(anisotropy) => edit("textures", { anisotropy })}
        />
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-textures-budget">
          Texture Budget (MiB)
        </FieldLabel>
        <NumberField
          id="quality-textures-budget"
          min={1}
          value={effective.textures.byteBudget / 1024 ** 2}
          onChange={(mib) => edit("textures", { byteBudget: mib * 1024 ** 2 })}
        />
        <FieldDescription>
          Textures category. Uploaded texture accounting drives cache eviction;
          referenced textures retain their ownership.
        </FieldDescription>
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-postprocessing-scale">
          Post Processing Resolution Scale
        </FieldLabel>
        <NumberField
          id="quality-postprocessing-scale"
          min={0.25}
          max={1}
          step={0.05}
          value={effective.postprocessing.resolutionScale}
          onChange={(resolutionScale) =>
            edit("postprocessing", { resolutionScale })
          }
        />
        <FieldDescription>
          Applies to passes authored with Scalable Resolution. Authored
          enablement and pass order are retained.
        </FieldDescription>
      </Field>
      <Field className="settings-field">
        <FieldLabel htmlFor="quality-lighting-mode">
          Local Light Budget Mode
        </FieldLabel>
        <Select
          value={effective.lighting.localLightMode}
          onValueChange={(mode) => {
            if (mode === "auto" || mode === "manual")
              edit("lighting", { localLightMode: mode });
          }}
        >
          <SelectTrigger id="quality-lighting-mode">
            <SelectValue>
              {effective.lighting.localLightMode === "auto" ? "Auto" : "Manual"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          Lighting category. {resolveLocalLightBudget(effective.lighting)} local
          lights requested within the{" "}
          {QUALITY_TARGET_LABELS[effective.lighting.profile ?? "medium"]} tier;
          hardware shader/storage admission can limit this further. Sun and fill
          lights use separate slots.
        </FieldDescription>
      </Field>
      {effective.lighting.localLightMode === "manual" ? (
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-lighting-budget">
            Local Light Budget
          </FieldLabel>
          <NumberField
            id="quality-lighting-budget"
            min={0}
            value={effective.lighting.maxLocalLights}
            onChange={(maxLocalLights) => edit("lighting", { maxLocalLights })}
          />
        </Field>
      ) : null}
    </FieldSet>
  );
}

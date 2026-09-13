import { QUALITY_GROUPS, QUALITY_LEVELS, qualityGroupLabel, qualityPresetPatch, resolveRenderingQuality, normalizeRenderingQuality, normalizeShadowSettings, type RenderProjectSettings, type QualityGroup, type QualityLevel } from "@babylonslate/core";
import { NumberField } from "@babylonslate/editor-kit";
import { Field, FieldLabel, FieldDescription, FieldSet, FieldLegend } from "@babylonslate/ui/components/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@babylonslate/ui/components/select";
import { Switch } from "@babylonslate/ui/components/switch";

const labels = { shadows: "Shadows", resolution: "Resolution", textures: "Textures", postprocessing: "Post Processing" };
export function RenderQualityFields({ settings, onChange }: { settings: RenderProjectSettings; onChange: (settings: RenderProjectSettings) => void }) {
  const effective = resolveRenderingQuality(settings);
  const apply = (level: QualityLevel, group?: QualityGroup) => {
    const patch = qualityPresetPatch(level, group);
    onChange({ ...settings, shadows: normalizeShadowSettings({ ...effective.shadows, ...patch.shadows }),
      quality: normalizeRenderingQuality({ ...effective, ...patch }) });
  };
  const displayLabel = (value: string) => value[0]!.toUpperCase() + value.slice(1);
  const groupLabels = QUALITY_GROUPS.map((group) => qualityGroupLabel(effective, group));
  const overall = groupLabels.every((value) => value === groupLabels[0]) ? groupLabels[0]! : "custom";
  return <FieldSet>
    <FieldLegend>Scalability</FieldLegend>
    {([undefined, ...QUALITY_GROUPS] as (QualityGroup | undefined)[]).map((group) => <Field key={group ?? "all"} className="settings-field">
      <FieldLabel htmlFor={`quality-${group ?? "all"}`}>{group ? `${labels[group]} Quality` : "Overall Quality"}</FieldLabel>
      <Select value={group ? qualityGroupLabel(effective, group) : overall} onValueChange={(value) => { if (value && value !== "custom") apply(value as QualityLevel, group); }}>
        <SelectTrigger id={`quality-${group ?? "all"}`}><SelectValue>{displayLabel(group ? qualityGroupLabel(effective, group) : overall)}</SelectValue></SelectTrigger>
        <SelectContent><SelectGroup>
          <SelectItem value="custom" disabled>Custom</SelectItem>
          {QUALITY_LEVELS.map((level) => <SelectItem key={level} value={level}>{level[0]!.toUpperCase() + level.slice(1)}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
    </Field>)}
    <Field className="settings-field"><FieldLabel htmlFor="quality-resolution-scale">Resolution Scale</FieldLabel>
      <NumberField id="quality-resolution-scale" value={effective.resolution.scale} min={0.25} max={1} step={0.05}
        onChange={(scale) => onChange({ ...settings, quality: { ...effective, resolution: { ...effective.resolution, scale } } })} />
      <FieldDescription>Fraction of the target width and height. Runtime quality commands can override this for the session.</FieldDescription>
    </Field>
    <Field className="settings-field"><FieldLabel htmlFor="quality-resolution-dynamic">Dynamic Resolution</FieldLabel>
      <Switch id="quality-resolution-dynamic" checked={effective.resolution.dynamic} onCheckedChange={(dynamic) => onChange({ ...settings, quality: { ...effective, resolution: { ...effective.resolution, dynamic } } })} />
    </Field>
    <Field className="settings-field"><FieldLabel htmlFor="quality-resolution-minimum">Minimum Resolution Scale</FieldLabel>
      <NumberField id="quality-resolution-minimum" value={effective.resolution.minScale} min={0.25} max={effective.resolution.scale} step={0.05} disabled={!effective.resolution.dynamic}
        onChange={(minScale) => onChange({ ...settings, quality: { ...effective, resolution: { ...effective.resolution, minScale } } })} />
    </Field>
  </FieldSet>;
}

import {
  QUALITY_GROUPS,
  QUALITY_LEVELS,
  qualityGroupLabel,
  qualityPresetPatch,
  resolveRenderingQuality,
  applyProjectQualityPatch,
  qualitySettingPatch,
  QUALITY_TARGET_LABELS,
  LOD_DISTANCE_SCALE_MAX,
  LOD_DISTANCE_SCALE_MIN,
  WATER_CONTACT_RESOLUTION_MAX,
  WATER_CONTACT_RESOLUTION_MIN,
  WATER_FFT_CASCADES_MAX,
  WATER_FFT_CASCADES_MIN,
  WATER_FFT_SIZES,
  WATER_MESH_DENSITY_MAX,
  WATER_MESH_DENSITY_MIN,
  WATER_REFLECTION_MODES,
  WATER_REFLECTION_STEPS_MAX,
  WATER_REFLECTION_STEPS_MIN,
  WATER_SHADING_DETAILS,
  WATER_TARGET_SCALE_MAX,
  WATER_TARGET_SCALE_MIN,
  resolveLocalLightBudget,
  type RenderProjectSettings,
  type QualityGroup,
  type QualityLevel,
  type WaterReflectionMode,
  type WaterShadingDetail,
} from "@babylonslate/core";
import { NumberField } from "@babylonslate/editor-kit";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldSet,
  FieldLegend,
  FieldGroup,
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
  geometry: "Geometry",
  water: "Water",
  postprocessing: "Post Processing",
};
const reflectionLabels: Record<WaterReflectionMode, string> = {
  sky: "Sky Only",
  screenSpace: "Screen Space",
  planar: "Planar",
};
export function RenderQualityFields({
  settings,
  onChange,
  hideTitle = false,
}: {
  settings: RenderProjectSettings;
  onChange: (settings: RenderProjectSettings) => void;
  hideTitle?: boolean;
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
  const water = effective.water;
  // Refraction and Screen Space reflections (also Planar's fallback) share one scene copy.
  const sceneCopy = water.refraction || water.reflections !== "sky";
  return (
    <FieldSet>
      <FieldLegend className={hideTitle ? "sr-only" : undefined}>Scalability</FieldLegend>
      <FieldGroup className="gap-2">
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
                  Low targets a budget Android phone, Medium an Apple A16, and
                  Ultra a high-end gaming PC.
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
          <FieldDescription>Fraction of the target width and height.</FieldDescription>
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
          <FieldLabel htmlFor="quality-textures-lod">
            Texture LOD Bias
          </FieldLabel>
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
            onChange={(mib) =>
              edit("textures", { byteBudget: mib * 1024 ** 2 })
            }
          />
          <FieldDescription>Unused textures are released above this budget.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-geometry-lod">Auto LOD</FieldLabel>
          <Switch
            id="quality-geometry-lod"
            checked={effective.geometry.autoLod}
            onCheckedChange={(autoLod) => edit("geometry", { autoLod })}
          />
          <FieldDescription>Distant models draw simplified meshes. Each Model&apos;s Auto LOD controls whether levels are generated.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-geometry-distance">
            LOD Distance Scale
          </FieldLabel>
          <NumberField
            id="quality-geometry-distance"
            min={LOD_DISTANCE_SCALE_MIN}
            max={LOD_DISTANCE_SCALE_MAX}
            step={0.25}
            value={effective.geometry.lodDistanceScale}
            disabled={!effective.geometry.autoLod}
            onChange={(lodDistanceScale) => edit("geometry", { lodDistanceScale })}
          />
          <FieldDescription>Higher values keep full detail farther away.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-shading">Water Shading Detail</FieldLabel>
          <Select
            value={water.shadingDetail}
            onValueChange={(shadingDetail) => {
              if (WATER_SHADING_DETAILS.includes(shadingDetail as WaterShadingDetail))
                edit("water", { shadingDetail: shadingDetail as WaterShadingDetail });
            }}
          >
            <SelectTrigger id="quality-water-shading">
              <SelectValue>{displayLabel(water.shadingDetail)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {WATER_SHADING_DETAILS.map((detail) => (
                  <SelectItem key={detail} value={detail}>
                    {displayLabel(detail)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>Built-in water shading terms. Buoyancy and wave queries never change.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-mesh">Water Mesh Density</FieldLabel>
          <NumberField
            id="quality-water-mesh"
            min={WATER_MESH_DENSITY_MIN}
            max={WATER_MESH_DENSITY_MAX}
            step={0.25}
            value={water.meshDensity}
            onChange={(meshDensity) => edit("water", { meshDensity })}
          />
          <FieldDescription>Multiplies each body&apos;s Surface Resolution.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-contact">Contact Resolution</FieldLabel>
          <NumberField
            id="quality-water-contact"
            min={WATER_CONTACT_RESOLUTION_MIN}
            max={WATER_CONTACT_RESOLUTION_MAX}
            step={128}
            value={water.contactResolution}
            onChange={(contactResolution) => edit("water", { contactResolution })}
          />
          <FieldDescription>Maximum contact foam cells per side.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-refraction">Water Refraction</FieldLabel>
          <Switch
            id="quality-water-refraction"
            data-testid="quality-water-refraction"
            checked={water.refraction}
            onCheckedChange={(refraction) => edit("water", { refraction })}
          />
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-refraction-scale">Refraction Resolution</FieldLabel>
          <NumberField
            id="quality-water-refraction-scale"
            min={WATER_TARGET_SCALE_MIN}
            max={WATER_TARGET_SCALE_MAX}
            step={0.05}
            value={water.refractionScale}
            disabled={!sceneCopy}
            onChange={(refractionScale) => edit("water", { refractionScale })}
          />
          <FieldDescription>Scene copy scale, shared with Screen Space reflections.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-reflections">Water Reflections</FieldLabel>
          <Select
            value={water.reflections}
            onValueChange={(reflections) => {
              if (WATER_REFLECTION_MODES.includes(reflections as WaterReflectionMode))
                edit("water", { reflections: reflections as WaterReflectionMode });
            }}
          >
            <SelectTrigger id="quality-water-reflections">
              <SelectValue>{reflectionLabels[water.reflections]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {WATER_REFLECTION_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {reflectionLabels[mode]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>Planar mirrors flat water and uses Screen Space elsewhere.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-reflection-steps">Reflection Steps</FieldLabel>
          <NumberField
            id="quality-water-reflection-steps"
            min={WATER_REFLECTION_STEPS_MIN}
            max={WATER_REFLECTION_STEPS_MAX}
            step={1}
            value={water.reflectionSteps}
            disabled={water.reflections === "sky"}
            onChange={(reflectionSteps) => edit("water", { reflectionSteps })}
          />
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-planar-scale">Planar Resolution</FieldLabel>
          <NumberField
            id="quality-water-planar-scale"
            min={WATER_TARGET_SCALE_MIN}
            max={WATER_TARGET_SCALE_MAX}
            step={0.05}
            value={water.planarScale}
            disabled={water.reflections !== "planar"}
            onChange={(planarScale) => edit("water", { planarScale })}
          />
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-fft">FFT Ocean Detail</FieldLabel>
          <Switch
            id="quality-water-fft"
            data-testid="quality-water-fft"
            checked={water.fft}
            onCheckedChange={(fft) => edit("water", { fft })}
          />
          <FieldDescription>GPU wave detail drawn only; floating objects follow the same waves on every tier.</FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-fft-size">FFT Size</FieldLabel>
          <Select
            value={String(water.fftSize)}
            disabled={!water.fft}
            onValueChange={(size) => {
              if (size) edit("water", { fftSize: Number(size) });
            }}
          >
            <SelectTrigger id="quality-water-fft-size">
              <SelectValue>{water.fftSize}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {WATER_FFT_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="quality-water-fft-cascades">FFT Cascades</FieldLabel>
          <NumberField
            id="quality-water-fft-cascades"
            min={WATER_FFT_CASCADES_MIN}
            max={WATER_FFT_CASCADES_MAX}
            step={1}
            value={water.fftCascades}
            disabled={!water.fft}
            onChange={(fftCascades) => edit("water", { fftCascades })}
          />
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
          <FieldDescription>Applies to passes with Scalable Resolution.</FieldDescription>
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
                {effective.lighting.localLightMode === "auto"
                  ? "Auto"
                  : "Manual"}
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
            {resolveLocalLightBudget(effective.lighting)} local lights requested.{" "}
            {effective.lighting.localLightMode === "auto"
              ? `Auto follows the ${QUALITY_TARGET_LABELS[effective.lighting.profile ?? "medium"]} target.`
              : "Manual overrides the Auto target."}{" "}
            Sun and fill lights use separate slots.
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
              onChange={(maxLocalLights) =>
                edit("lighting", { maxLocalLights })
              }
            />
          </Field>
        ) : null}
      </FieldGroup>
    </FieldSet>
  );
}

import {
  RENDER_EFFECTS_LIMITS,
  type RenderEffectsSettings,
} from "@babylonslate/core";
import { ColorField, NumberField } from "@babylonslate/editor-kit";
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

const pipelineLabels = {
  legacyDisplay: "Legacy Display",
  sceneLinear: "Scene Linear",
} as const;

const toneMappingLabels = {
  none: "None",
  standard: "Standard",
  aces: "ACES",
  neutral: "Neutral",
} as const;

type Props = {
  project: RenderEffectsSettings;
  onChange: (value: RenderEffectsSettings) => void;
  hideTitle?: boolean;
};

/** Project Settings → Rendering post-processing group: the color pipeline
 * stage plus the display-space effect chain (bloom, vignette, FXAA). */
export function RenderEffectsFields({ project, onChange, hideTitle = false }: Props) {
  const patch = (value: Partial<RenderEffectsSettings>) =>
    onChange({ ...project, ...value });
  const patchVignette = (value: Partial<RenderEffectsSettings["vignette"]>) =>
    patch({ vignette: { ...project.vignette, ...value } });
  const patchBloom = (value: Partial<RenderEffectsSettings["bloom"]>) =>
    patch({ bloom: { ...project.bloom, ...value } });
  return (
    <FieldSet data-testid="project-render-effects">
      <FieldLegend className={hideTitle ? "sr-only" : undefined}>Post Processing</FieldLegend>
      <FieldGroup className="gap-2">
        <Field className="settings-field">
          <FieldLabel htmlFor="project-effects-pipeline">Color Pipeline</FieldLabel>
          <Select
            value={project.colorPipeline.mode}
            onValueChange={(mode) => {
              if (mode === "legacyDisplay" || mode === "sceneLinear")
                patch({ colorPipeline: { version: 1, mode } });
            }}
          >
            <SelectTrigger id="project-effects-pipeline" aria-describedby="project-effects-pipeline-description" data-testid="project-effects-pipeline">
              <SelectValue>{pipelineLabels[project.colorPipeline.mode]}</SelectValue>
            </SelectTrigger>
            <SelectContent><SelectGroup>
              {Object.entries(pipelineLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectGroup></SelectContent>
          </Select>
          <FieldDescription id="project-effects-pipeline-description">
            Scene Linear renders PBR lighting in HDR and resolves tone mapping, exposure and contrast in a display stage. CEL stays display-space.
          </FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="project-effects-tone-mapping">Tone Mapping</FieldLabel>
          <Select
            value={project.toneMapping}
            disabled={project.colorPipeline.mode !== "sceneLinear"}
            onValueChange={(toneMapping) => {
              if (toneMapping && toneMapping in toneMappingLabels)
                patch({ toneMapping: toneMapping as RenderEffectsSettings["toneMapping"] });
            }}
          >
            <SelectTrigger id="project-effects-tone-mapping" aria-describedby="project-effects-tone-mapping-description" data-testid="project-effects-tone-mapping">
              <SelectValue>{toneMappingLabels[project.toneMapping]}</SelectValue>
            </SelectTrigger>
            <SelectContent><SelectGroup>
              {Object.entries(toneMappingLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectGroup></SelectContent>
          </Select>
          <FieldDescription id="project-effects-tone-mapping-description">
            Applies in the Scene Linear display stage only.
          </FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="project-effects-exposure">Exposure</FieldLabel>
          <NumberField
            id="project-effects-exposure"
            aria-describedby="project-effects-exposure-description"
            data-testid="project-effects-exposure"
            value={project.exposure}
            min={RENDER_EFFECTS_LIMITS.exposure[0]}
            max={RENDER_EFFECTS_LIMITS.exposure[1]}
            step={0.01}
            disabled={project.colorPipeline.mode !== "sceneLinear"}
            onChange={(exposure) => patch({ exposure })}
          />
          <FieldDescription id="project-effects-exposure-description">
            Scene Linear brightness multiplier before tone mapping.
          </FieldDescription>
        </Field>
        <Field className="settings-field">
          <FieldLabel htmlFor="project-effects-contrast">Contrast</FieldLabel>
          <NumberField
            id="project-effects-contrast"
            aria-describedby="project-effects-contrast-description"
            data-testid="project-effects-contrast"
            value={project.contrast}
            min={RENDER_EFFECTS_LIMITS.contrast[0]}
            max={RENDER_EFFECTS_LIMITS.contrast[1]}
            step={0.01}
            disabled={project.colorPipeline.mode !== "sceneLinear"}
            onChange={(contrast) => patch({ contrast })}
          />
          <FieldDescription id="project-effects-contrast-description">
            Scene Linear contrast curve strength.
          </FieldDescription>
        </Field>
        <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="project-effects-bloom">Bloom</FieldLabel>
          <Switch
            id="project-effects-bloom"
            aria-describedby="project-effects-bloom-description"
            data-testid="project-effects-bloom"
            checked={project.bloom.enabled}
            onCheckedChange={(enabled) => patchBloom({ enabled: enabled === true })}
          />
          <FieldDescription id="project-effects-bloom-description">
            Threshold glow around bright surfaces.
          </FieldDescription>
        </Field>
        {project.bloom.enabled ? (
          <>
            <Field className="settings-field">
              <FieldLabel htmlFor="project-effects-bloom-threshold">Bloom Threshold</FieldLabel>
              <NumberField
                id="project-effects-bloom-threshold"
                data-testid="project-effects-bloom-threshold"
                value={project.bloom.threshold}
                min={RENDER_EFFECTS_LIMITS.bloomThreshold[0]}
                max={RENDER_EFFECTS_LIMITS.bloomThreshold[1]}
                step={0.01}
                onChange={(threshold) => patchBloom({ threshold })}
              />
            </Field>
            <Field className="settings-field">
              <FieldLabel htmlFor="project-effects-bloom-weight">Bloom Weight</FieldLabel>
              <NumberField
                id="project-effects-bloom-weight"
                data-testid="project-effects-bloom-weight"
                value={project.bloom.weight}
                min={RENDER_EFFECTS_LIMITS.bloomWeight[0]}
                max={RENDER_EFFECTS_LIMITS.bloomWeight[1]}
                step={0.01}
                onChange={(weight) => patchBloom({ weight })}
              />
            </Field>
            <Field className="settings-field">
              <FieldLabel htmlFor="project-effects-bloom-kernel">Bloom Kernel</FieldLabel>
              <NumberField
                id="project-effects-bloom-kernel"
                data-testid="project-effects-bloom-kernel"
                value={project.bloom.kernel}
                min={RENDER_EFFECTS_LIMITS.bloomKernel[0]}
                max={RENDER_EFFECTS_LIMITS.bloomKernel[1]}
                step={1}
                onChange={(kernel) => patchBloom({ kernel })}
              />
            </Field>
            <Field className="settings-field">
              <FieldLabel htmlFor="project-effects-bloom-scale">Bloom Scale</FieldLabel>
              <NumberField
                id="project-effects-bloom-scale"
                aria-describedby="project-effects-bloom-scale-description"
                data-testid="project-effects-bloom-scale"
                value={project.bloom.scale}
                min={RENDER_EFFECTS_LIMITS.bloomScale[0]}
                max={RENDER_EFFECTS_LIMITS.bloomScale[1]}
                step={0.05}
                onChange={(scale) => patchBloom({ scale })}
              />
              <FieldDescription id="project-effects-bloom-scale-description">
                Bloom target size relative to the post-processing resolution.
              </FieldDescription>
            </Field>
          </>
        ) : null}
        <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="project-effects-vignette">Vignette</FieldLabel>
          <Switch
            id="project-effects-vignette"
            aria-describedby="project-effects-vignette-description"
            data-testid="project-effects-vignette"
            checked={project.vignette.enabled}
            onCheckedChange={(enabled) => patchVignette({ enabled: enabled === true })}
          />
          <FieldDescription id="project-effects-vignette-description">
            Darkened frame edges; applies in every pipeline mode.
          </FieldDescription>
        </Field>
        {project.vignette.enabled ? (
          <>
            <Field className="settings-field">
              <FieldLabel htmlFor="project-effects-vignette-weight">Vignette Weight</FieldLabel>
              <NumberField
                id="project-effects-vignette-weight"
                data-testid="project-effects-vignette-weight"
                value={project.vignette.weight}
                min={RENDER_EFFECTS_LIMITS.vignetteWeight[0]}
                max={RENDER_EFFECTS_LIMITS.vignetteWeight[1]}
                step={0.01}
                onChange={(weight) => patchVignette({ weight })}
              />
            </Field>
            <Field className="settings-field">
              <FieldLabel htmlFor="project-effects-vignette-color">Vignette Color</FieldLabel>
              <ColorField
                id="project-effects-vignette-color"
                data-testid="project-effects-vignette-color"
                value={project.vignette.color}
                onChange={(color) => patchVignette({ color })}
              />
            </Field>
          </>
        ) : null}
        <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="project-effects-fxaa">FXAA</FieldLabel>
          <Switch
            id="project-effects-fxaa"
            aria-describedby="project-effects-fxaa-description"
            data-testid="project-effects-fxaa"
            checked={project.fxaa}
            onCheckedChange={(checked) => patch({ fxaa: checked === true })}
          />
          <FieldDescription id="project-effects-fxaa-description">
            Full-screen edge anti-aliasing.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}

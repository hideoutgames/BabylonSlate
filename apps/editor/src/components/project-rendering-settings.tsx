import {
  MAX_WATER_BLEND_DISTANCE,
  normalizeCelShadingSettings,
  normalizeEnvironmentLightingSettings,
  normalizeRenderEffectsSettings,
  normalizeShadowSettings,
  normalizeWaterBlendDistance,
  type ProjectDocument,
} from "@haptic/core";
import {
  AssetPickerControl,
  NumberField,
  assetRowIdentity,
  selectedPickerIdentity,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { Switch } from "@haptic/ui/components/switch";
import type { DocumentActions, RegistryState } from "../context/document-context-types";
import { CelShadingFields } from "./cel-shading-fields";
import { EnvironmentLightingFields } from "./environment-lighting-fields";
import { PlayPreviewSettingsFields } from "./play-preview-settings-fields";
import { RenderEffectsFields } from "./render-effects-fields";
import { RenderPipelineFields } from "./render-pipeline-fields";
import { RenderQualityFields } from "./render-quality-fields";
import { ShadowSettingsFields } from "./shadow-settings-fields";
import { SettingsSection } from "./settings-section";

interface ProjectRenderingSettingsProps {
  projectDocument: ProjectDocument;
  /** The host's wrapper: render, Play Frame Cap and Play Preview edits wait for Done. */
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  assetRegistry: RegistryState["assetRegistry"];
  setLutPickerOpen: (open: boolean) => void;
}

/** Project Settings → Rendering, not the Updating Rendering dialog. The host renders the LUT picker. */
export function ProjectRenderingSettings({
  projectDocument,
  updateProjectSettings,
  assetRegistry,
  setLutPickerOpen,
}: ProjectRenderingSettingsProps) {
  return (
    <FieldGroup>
        <SettingsSection id="pipeline" title="Pipeline">
        <RenderPipelineFields hideTitle scope="project" project={projectDocument.settings.render}
          onChange={(pipeline) => updateProjectSettings({ render: { ...projectDocument.settings.render, ...pipeline } })} />
        <Field className="settings-field">
          <FieldLabel htmlFor="setting-render-mode">Render Mode</FieldLabel>
          <Select value={projectDocument.settings.render.mode ?? "pbr"}
            onValueChange={(mode) => {
              if (mode === "pbr" || mode === "cel") updateProjectSettings({ render: { ...projectDocument.settings.render, mode } });
            }}>
            <SelectTrigger id="setting-render-mode" data-testid="setting-render-mode">
              <SelectValue>{projectDocument.settings.render.mode === "cel" ? "CEL" : "PBR"}</SelectValue>
            </SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="pbr">PBR</SelectItem>
              <SelectItem value="cel">CEL</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
          <FieldDescription>CEL uses banded lighting. Scenes can override its style.</FieldDescription>
        </Field>
        </SettingsSection>
        <SettingsSection id="scalability" title="Scalability">
          <RenderQualityFields hideTitle settings={projectDocument.settings.render} onChange={(render) => updateProjectSettings({ render })} />
        </SettingsSection>
        <SettingsSection id="shadows" title="Shadows">
          <ShadowSettingsFields hideTitle project={projectDocument.settings.render.shadows} onChange={(shadows) => updateProjectSettings({ render: { ...projectDocument.settings.render, shadows: normalizeShadowSettings(shadows) } })} />
        </SettingsSection>
        <SettingsSection id="environment" title="Environment Lighting">
          <EnvironmentLightingFields hideTitle cel={projectDocument.settings.render.mode === "cel"} project={projectDocument.settings.render.environmentLighting} onChange={(environmentLighting) => updateProjectSettings({ render: { ...projectDocument.settings.render, environmentLighting: normalizeEnvironmentLightingSettings(environmentLighting) } })} />
        </SettingsSection>
        <SettingsSection id="postProcessing" title="Post Processing">
          <RenderEffectsFields
            hideTitle
            project={normalizeRenderEffectsSettings(projectDocument.settings.render.effects)}
            onChange={(effects) => updateProjectSettings({ render: { ...projectDocument.settings.render, effects: normalizeRenderEffectsSettings(effects) } })}
            lutControl={
              <AssetPickerControl value={normalizeRenderEffectsSettings(projectDocument.settings.render.effects).colorGrading.lutTextureGuid}>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
                  onClick={() => setLutPickerOpen(true)}
                  data-testid="project-effects-lut"
                  id="project-effects-lut"
                >
                  {selectedPickerIdentity(
                    assetRowIdentity(
                      (() => {
                        const guid = normalizeRenderEffectsSettings(projectDocument.settings.render.effects).colorGrading.lutTextureGuid;
                        const asset = guid ? assetRegistry?.getByGuid(guid) : undefined;
                        return asset ? { name: asset.header.name, type: asset.header.type } : undefined;
                      })(),
                    ),
                  )}
                </Button>
              </AssetPickerControl>
            }
          />
        </SettingsSection>
        {projectDocument.settings.render.mode === "cel" ? (
          <SettingsSection id="cel" title="CEL Shading">
            <CelShadingFields
              hideTitle
              project={normalizeCelShadingSettings(projectDocument.settings.render.cel)}
              onChange={(cel) => updateProjectSettings({ render: { ...projectDocument.settings.render, cel: normalizeCelShadingSettings(cel) } })}
            />
          </SettingsSection>
        ) : null}
        <SettingsSection id="resolution" title="Resolution">
        <FieldGroup className="gap-2">
          <Field orientation="horizontal" className="settings-field">
          <FieldLabel htmlFor="setting-render-custom">
            Custom Resolution
          </FieldLabel>
          <Switch
            id="setting-render-custom"
            aria-describedby="setting-render-custom-description"
            checked={projectDocument.settings.render.customResolution}
            onCheckedChange={(checked) =>
              updateProjectSettings({
                render: {
                  ...projectDocument.settings.render,
                  customResolution: checked === true,
                },
              })
            }
            data-testid="setting-render-custom"
          />
          <FieldDescription id="setting-render-custom-description">
            Sets the design size for Play and exported games. Overrides
            Follow System.
          </FieldDescription>
        </Field>
          <Field className="settings-field settings-field-dependent">
          <FieldLabel htmlFor="setting-render-width">
            Render Size
          </FieldLabel>
          <div className="flex items-center gap-2">
            <NumberField
              id="setting-render-width"
              min={1}
              step={1}
              disabled={!projectDocument.settings.render.customResolution}
                className="min-h-[var(--chrome-row,28px)]"
              value={projectDocument.settings.render.width}
              onChange={(width) =>
                updateProjectSettings({
                  render: { ...projectDocument.settings.render, width },
                })
              }
              data-testid="setting-render-width"
              aria-label="Render Width"
            />
            <span aria-hidden="true">×</span>
            <NumberField
              id="setting-render-height"
              min={1}
              step={1}
              disabled={!projectDocument.settings.render.customResolution}
                className="min-h-[var(--chrome-row,28px)]"
              value={projectDocument.settings.render.height}
              onChange={(height) =>
                updateProjectSettings({
                  render: { ...projectDocument.settings.render, height },
                })
              }
              data-testid="setting-render-height"
              aria-label="Render Height"
            />
          </div>
        </Field>
        <Field orientation="horizontal" className="settings-field settings-field-dependent" data-disabled={!projectDocument.settings.render.customResolution}>
          <FieldLabel htmlFor="setting-render-black-bars">
            Black Bars
          </FieldLabel>
          <Switch
            id="setting-render-black-bars"
            aria-describedby="setting-render-black-bars-description"
            checked={projectDocument.settings.render.blackBars}
            disabled={!projectDocument.settings.render.customResolution}
            onCheckedChange={(checked) =>
              updateProjectSettings({
                render: {
                  ...projectDocument.settings.render,
                  blackBars: checked === true,
                },
              })
            }
            data-testid="setting-render-black-bars"
          />
          <FieldDescription id="setting-render-black-bars-description">
            Adds bars to preserve the design size. Off fills the window
            without stretching.
          </FieldDescription>
        </Field>
        {projectDocument.settings.render.customResolution ? (
          <Field className="settings-field settings-field-dependent">
            <FieldLabel htmlFor="setting-render-upscaling">Upscaling</FieldLabel>
            <Select value={projectDocument.settings.render.upscaling}
              onValueChange={(upscaling) => {
                if (upscaling === "smooth" || upscaling === "pixelated")
                  updateProjectSettings({ render: { ...projectDocument.settings.render, upscaling } });
              }}>
              <SelectTrigger id="setting-render-upscaling" data-testid="setting-render-upscaling"
                aria-describedby="setting-render-upscaling-description">
                <SelectValue>{projectDocument.settings.render.upscaling === "pixelated" ? "Pixelated" : "Smooth"}</SelectValue>
              </SelectTrigger>
              <SelectContent><SelectGroup>
                <SelectItem value="smooth">Smooth</SelectItem>
                <SelectItem value="pixelated">Pixelated</SelectItem>
              </SelectGroup></SelectContent>
            </Select>
            <FieldDescription id="setting-render-upscaling-description">
              Pixelated enlarges the design size by the largest whole multiple
              that fits, with sharp square pixels, at full resolution. Without
              Black Bars the view extends to fill the window.
            </FieldDescription>
          </Field>
        ) : null}
        </FieldGroup>
        </SettingsSection>
        <SettingsSection id="water" title="Water">
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-water-blend-distance">Water Blend Distance</FieldLabel>
            <NumberField
              id="setting-water-blend-distance"
              min={0}
              max={MAX_WATER_BLEND_DISTANCE}
              step={0.5}
              className="min-h-[var(--chrome-row,28px)]"
              value={normalizeWaterBlendDistance(projectDocument.settings.render.water?.blendDistance)}
              onChange={(blendDistance) =>
                updateProjectSettings({
                  render: { ...projectDocument.settings.render, water: { ...projectDocument.settings.render.water, blendDistance: normalizeWaterBlendDistance(blendDistance) } },
                })
              }
              data-testid="setting-water-blend-distance"
            />
            <FieldDescription>
              Metres within which water bodies merge into one surface, in rendering and water queries. 0 turns it off.
            </FieldDescription>
          </Field>
        </SettingsSection>
        <SettingsSection id="playPreview" title="Play Preview">
        <FieldGroup className="gap-2">
          <Field className="settings-field">
          <FieldLabel htmlFor="setting-play-frame-cap">
              Play Frame Cap
          </FieldLabel>
          <NumberField
            id="setting-play-frame-cap"
            min={1}
              className="min-h-[var(--chrome-row,28px)]"
            data-testid="setting-play-frame-cap"
            value={projectDocument.settings.playFrameCap}
            onChange={(playFrameCap) =>
              updateProjectSettings({ playFrameCap })
            }
          />
          <FieldDescription>
              Applies to Play and Preview.
          </FieldDescription>
        </Field>
        <PlayPreviewSettingsFields
          settings={projectDocument.settings.playPreview}
          onChange={(playPreview) =>
            updateProjectSettings({ playPreview })
          }
        />
        </FieldGroup>
        </SettingsSection>
    </FieldGroup>
  );
}

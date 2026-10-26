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
  DisclosureSection,
  NumberField,
  assetRowIdentity,
  selectedPickerIdentity,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Checkbox } from "@haptic/ui/components/checkbox";
import {
  Field,
  FieldContent,
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
import { Switch } from "@haptic/ui/components/switch";
import type { DocumentActions, RegistryState } from "../context/document-context-types";
import type { RenderingSectionId } from "../lib/settings-search";
import { CelShadingFields } from "./cel-shading-fields";
import { EnvironmentLightingFields } from "./environment-lighting-fields";
import { PlayPreviewSettingsFields } from "./play-preview-settings-fields";
import { RenderEffectsFields } from "./render-effects-fields";
import { RenderPipelineFields } from "./render-pipeline-fields";
import { RenderQualityFields } from "./render-quality-fields";
import { ShadowSettingsFields } from "./shadow-settings-fields";

interface ProjectRenderingSettingsProps {
  projectDocument: ProjectDocument;
  /** The host's wrapper: render, Play Frame Cap and Play Preview edits wait for Done. */
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  assetRegistry: RegistryState["assetRegistry"];
  /** Disclosure state stays in the host so a search result can open a section. */
  renderingSection: (id: RenderingSectionId) => {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  };
  setLutPickerOpen: (open: boolean) => void;
}

/** Project Settings → Rendering, not the Updating Rendering dialog. The host renders the LUT picker. */
export function ProjectRenderingSettings({
  projectDocument,
  updateProjectSettings,
  assetRegistry,
  renderingSection,
  setLutPickerOpen,
}: ProjectRenderingSettingsProps) {
  return (
    <FieldGroup className="gap-4">
      <FieldSet>
        <FieldLegend>Rendering</FieldLegend>
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
        <DisclosureSection title="Scalability" {...renderingSection("scalability")}>
          <RenderQualityFields hideTitle settings={projectDocument.settings.render} onChange={(render) => updateProjectSettings({ render })} />
        </DisclosureSection>
        <DisclosureSection title="Shadows" {...renderingSection("shadows")}>
          <ShadowSettingsFields hideTitle project={projectDocument.settings.render.shadows} onChange={(shadows) => updateProjectSettings({ render: { ...projectDocument.settings.render, shadows: normalizeShadowSettings(shadows) } })} />
        </DisclosureSection>
        <DisclosureSection title="Environment Lighting" {...renderingSection("environment")}>
          <EnvironmentLightingFields hideTitle cel={projectDocument.settings.render.mode === "cel"} project={projectDocument.settings.render.environmentLighting} onChange={(environmentLighting) => updateProjectSettings({ render: { ...projectDocument.settings.render, environmentLighting: normalizeEnvironmentLightingSettings(environmentLighting) } })} />
        </DisclosureSection>
        <DisclosureSection title="Post Processing" {...renderingSection("postProcessing")}>
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
        </DisclosureSection>
        {projectDocument.settings.render.mode === "cel" ? (
          <DisclosureSection title="CEL Shading" {...renderingSection("cel")}>
            <CelShadingFields
              hideTitle
              project={normalizeCelShadingSettings(projectDocument.settings.render.cel)}
              onChange={(cel) => updateProjectSettings({ render: { ...projectDocument.settings.render, cel: normalizeCelShadingSettings(cel) } })}
            />
          </DisclosureSection>
        ) : null}
        <DisclosureSection title="Resolution" {...renderingSection("resolution")}>
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
          <Field className="settings-field">
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
        <Field orientation="horizontal">
          <Checkbox
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
          <FieldContent>
            <FieldLabel htmlFor="setting-render-black-bars">
              Black Bars
            </FieldLabel>
            <FieldDescription id="setting-render-black-bars-description">
              Adds bars to preserve the design size. Off fills the window
              without stretching.
            </FieldDescription>
          </FieldContent>
        </Field>
        </FieldGroup>
        </DisclosureSection>
        <DisclosureSection title="Water" {...renderingSection("water")}>
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
        </DisclosureSection>
        <DisclosureSection title="Play Preview" {...renderingSection("playPreview")}>
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
        </DisclosureSection>
      </FieldSet>
    </FieldGroup>
  );
}

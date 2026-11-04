import type { ReactNode } from "react";
import {
  MAX_WATER_BLEND_DISTANCE,
  normalizeCelShadingSettings,
  normalizeEnvironmentLightingSettings,
  normalizeRenderEffectsOverrides,
  normalizeRenderEffectsSettings,
  normalizeShadowSettings,
  normalizeWaterBlendDistance,
  resolveRenderEffectsSettings,
  type ProjectDocument,
  type RenderProjectSettings,
  type SceneSettings,
} from "@haptic/core";
import { LabelHint, NumberField } from "@haptic/editor-kit";
import { Field, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import type { DocumentActions, RegistryState } from "../context/document-context-types";
import { CelShadingFields, CEL_SHADING_SEARCH_TEXT } from "./cel-shading-fields";
import { EnvironmentLightingFields, ENVIRONMENT_LIGHTING_SEARCH_TEXT } from "./environment-lighting-fields";
import { PlayPreviewSettingsFields } from "./play-preview-settings-fields";
import { RenderEffectsFields, RENDER_EFFECTS_SEARCH_TEXT } from "./render-effects-fields";
import { projectEffectsScope, sceneEffectsScope } from "./render-effects-scope";
import { RenderPipelineFields } from "./render-pipeline-fields";
import { RenderQualityFields } from "./render-quality-fields";
import { ShadowSettingsFields, SHADOW_SETTINGS_SEARCH_TEXT } from "./shadow-settings-fields";
import { ProjectLutControl, RenderModeField, ResolutionFields } from "./rendering-project-fields";

/** What a section edits in Project Settings → Rendering. */
export interface RenderingProjectContext {
  projectDocument: ProjectDocument;
  render: RenderProjectSettings;
  /** Replaces the project's render settings (through the host's Done-gated wrapper). */
  setRender: (render: RenderProjectSettings) => void;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  assetRegistry: RegistryState["assetRegistry"];
  setLutPickerOpen: (open: boolean) => void;
}

/** What a section edits as a Scene's overrides in the Scene Inspector. */
export interface RenderingSceneContext {
  /** The project's render settings the overrides apply to; absent before a project loads. */
  render: Partial<RenderProjectSettings> | undefined;
  settings: SceneSettings;
  setSettings: (settings: SceneSettings) => void;
  /** Scene-only rows a section shows with its overrides (Environment Source and Texture). */
  environmentRows: ReactNode;
  /** The Scene's LUT Texture picker control, and the name its status line shows. */
  lutControl: (control: { id: string; disabled: boolean; describedBy?: string }) => ReactNode;
  lutName: (guid: string | null) => string;
}

export interface RenderingSettingsSection {
  /** The `SettingsSection` id, shared with `settings-search.ts` and the Scene Inspector's disclosure state. */
  id: string;
  title: string;
  /** False hides the section in Project Settings and the Scene Inspector alike. */
  available?: (render: Partial<RenderProjectSettings> | undefined) => boolean;
  project: (context: RenderingProjectContext) => ReactNode;
  /**
   * Present when a Scene can override the section. The Scene Inspector shows
   * these sections in this list's order, with the title, and filters by
   * `searchText`, which each fields component derives from its own rows.
   */
  scene?: { searchText: string; render: (context: RenderingSceneContext) => ReactNode };
}

const isCel = (render: Partial<RenderProjectSettings> | undefined) => render?.mode === "cel";

/**
 * Project Settings → Rendering, in order. The Scene Inspector's override
 * categories are the sections with `scene`, so a section's title, order,
 * availability and fields change in one place for both.
 */
export const RENDERING_SETTINGS_SECTIONS: readonly RenderingSettingsSection[] = [
  {
    id: "pipeline",
    title: "Pipeline",
    project: (context) => (
      <>
        <RenderPipelineFields hideTitle scope="project" project={context.render}
          onChange={(pipeline) => context.setRender({ ...context.render, ...pipeline })} />
        <RenderModeField {...context} />
      </>
    ),
  },
  {
    id: "scalability",
    title: "Scalability",
    project: ({ render, setRender }) => <RenderQualityFields hideTitle settings={render} onChange={setRender} />,
  },
  {
    id: "shadows",
    title: "Shadows",
    project: ({ render, setRender }) => (
      <ShadowSettingsFields hideTitle project={render.shadows}
        onChange={(shadows) => setRender({ ...render, shadows: normalizeShadowSettings(shadows) })} />
    ),
    scene: {
      searchText: SHADOW_SETTINGS_SEARCH_TEXT,
      render: ({ render, settings, setSettings }) => (
        <ShadowSettingsFields hideTitle project={render?.shadows} overrides={settings.shadowOverrides ?? {}}
          onChange={(shadowOverrides) => setSettings({ ...settings, shadowOverrides })} />
      ),
    },
  },
  {
    id: "environment",
    title: "Environment Lighting",
    project: ({ render, setRender }) => (
      <EnvironmentLightingFields hideTitle cel={isCel(render)} project={render.environmentLighting}
        onChange={(environmentLighting) => setRender({ ...render, environmentLighting: normalizeEnvironmentLightingSettings(environmentLighting) })} />
    ),
    scene: {
      searchText: ENVIRONMENT_LIGHTING_SEARCH_TEXT,
      render: ({ render, settings, setSettings, environmentRows }) => (
        <EnvironmentLightingFields hideTitle cel={isCel(render)} project={render?.environmentLighting}
          overrides={settings.environmentLighting ?? {}}
          onChange={(environmentLighting) => setSettings({ ...settings, environmentLighting })}>
          {environmentRows}
        </EnvironmentLightingFields>
      ),
    },
  },
  {
    id: "postProcessing",
    title: "Post Processing",
    project: (context) => (
      <RenderEffectsFields
        hideTitle
        scope={projectEffectsScope(
          normalizeRenderEffectsSettings(context.render.effects),
          (effects) => context.setRender({ ...context.render, effects: normalizeRenderEffectsSettings(effects) }),
        )}
        lutControl={(control) => <ProjectLutControl context={context} control={control} />}
      />
    ),
    scene: {
      searchText: RENDER_EFFECTS_SEARCH_TEXT,
      render: ({ render, settings, setSettings, lutControl, lutName }) => {
        const project = normalizeRenderEffectsSettings(render?.effects);
        const overrides = settings.effectsOverrides ?? {};
        const scope = sceneEffectsScope(project, resolveRenderEffectsSettings(project, overrides), overrides,
          (next) => setSettings({ ...settings, effectsOverrides: normalizeRenderEffectsOverrides(next) }));
        return <RenderEffectsFields hideTitle scope={scope} lutControl={lutControl} lutName={lutName} />;
      },
    },
  },
  {
    id: "cel",
    title: "CEL Shading",
    available: isCel,
    project: ({ render, setRender }) => (
      <CelShadingFields hideTitle project={normalizeCelShadingSettings(render.cel)}
        onChange={(cel) => setRender({ ...render, cel: normalizeCelShadingSettings(cel) })} />
    ),
    scene: {
      searchText: CEL_SHADING_SEARCH_TEXT,
      render: ({ render, settings, setSettings }) => (
        <CelShadingFields hideTitle project={normalizeCelShadingSettings(render?.cel)} overrides={settings.celShading ?? {}}
          onChange={(celShading) => setSettings({ ...settings, celShading })} />
      ),
    },
  },
  {
    id: "resolution",
    title: "Resolution",
    project: (context) => <ResolutionFields {...context} />,
  },
  {
    id: "water",
    title: "Water",
    project: ({ render, setRender }) => (
      <Field className="settings-field">
        <LabelHint hint="Metres within which water bodies merge into one surface, in rendering and water queries. 0 turns it off.">
          <FieldLabel htmlFor="setting-water-blend-distance">Water Blend Distance</FieldLabel>
        </LabelHint>
        <NumberField
          id="setting-water-blend-distance"
          min={0}
          max={MAX_WATER_BLEND_DISTANCE}
          step={0.5}
          className="min-h-[var(--chrome-row,28px)]"
          value={normalizeWaterBlendDistance(render.water?.blendDistance)}
          onChange={(blendDistance) =>
            setRender({ ...render, water: { ...render.water, blendDistance: normalizeWaterBlendDistance(blendDistance) } })}
          data-testid="setting-water-blend-distance"
        />
      </Field>
    ),
  },
  {
    id: "playPreview",
    title: "Play Preview",
    project: ({ projectDocument, updateProjectSettings }) => (
      <FieldGroup className="gap-2">
        <Field className="settings-field">
          <FieldLabel htmlFor="setting-play-frame-cap">Play Frame Cap</FieldLabel>
          <NumberField
            id="setting-play-frame-cap"
            min={1}
            className="min-h-[var(--chrome-row,28px)]"
            data-testid="setting-play-frame-cap"
            value={projectDocument.settings.playFrameCap}
            onChange={(playFrameCap) => updateProjectSettings({ playFrameCap })}
          />
        </Field>
        <PlayPreviewSettingsFields
          settings={projectDocument.settings.playPreview}
          onChange={(playPreview) => updateProjectSettings({ playPreview })}
        />
      </FieldGroup>
    ),
  },
];

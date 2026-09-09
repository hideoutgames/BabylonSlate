import { NumberField, SelectableText } from "@babylonslate/editor-kit";
import { getBuildIdentity } from "../lib/build-identity";
import type { EngineSettings } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import { Slider } from "@babylonslate/ui/components/slider";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { PlusIcon, XIcon } from "lucide-react";
import {
  focusKeepCandidates,
  type FocusDocumentKind,
} from "../shell/layout-ops";
import type { DockWindowOptions } from "../shell/window-catalog";

type FocusKeepSettingKey = keyof EngineSettings["focusKeepPanels"];

const FOCUS_KEEP_SETTING_ROWS: Array<{
  kind: FocusDocumentKind;
  keepKey: FocusKeepSettingKey;
  label: string;
  options?: DockWindowOptions;
}> = [
  { kind: "scene", keepKey: "scene", label: "Scene" },
  { kind: "scene-layer", keepKey: "scene-layer", label: "Scene Layer" },
  { kind: "graph", keepKey: "graph", label: "Class" },
  { kind: "enum", keepKey: "enum", label: "Enum" },
  { kind: "structure", keepKey: "structure", label: "Structure" },
  {
    kind: "script-interface",
    keepKey: "script-interface",
    label: "Script Interface",
  },
  { kind: "sprite", keepKey: "sprite", label: "Sprite" },
  {
    kind: "sprite-animation",
    keepKey: "sprite-animation",
    label: "Sprite Animation",
  },
  { kind: "tileset", keepKey: "tileset", label: "Tileset" },
  { kind: "tilemap", keepKey: "tilemap", label: "Tilemap" },
  { kind: "material", keepKey: "material", label: "Material" },
  {
    kind: "material-function",
    keepKey: "material-function",
    label: "Material Function",
  },
  {
    kind: "anim-graph",
    keepKey: "anim-graph",
    label: "Animation Graph State Machine",
  },
  {
    kind: "anim-graph",
    keepKey: "animGraphObject",
    label: "Animation Graph Object",
    options: { animEditorMode: "animationObject" },
  },
  {
    kind: "behaviour-tree",
    keepKey: "behaviour-tree",
    label: "Behaviour Tree",
  },
  {
    kind: "audio",
    keepKey: "audio",
    label: "Audio",
  },
  {
    kind: "audio-mixer",
    keepKey: "audio-mixer",
    label: "Audio Mixer",
  },
  {
    kind: "audio-channel",
    keepKey: "audio-channel",
    label: "Audio Channel",
  },
  {
    kind: "sound-attenuation",
    keepKey: "sound-attenuation",
    label: "Sound Attenuation",
  },
  {
    kind: "particle-emitter",
    keepKey: "particle-emitter",
    label: "Particle Emitter",
  },
  {
    kind: "particle-system",
    keepKey: "particle-system",
    label: "Particle System",
  },
  { kind: "model", keepKey: "model", label: "Model" },
  { kind: "skeleton", keepKey: "skeleton", label: "Skeleton" },
  { kind: "animation", keepKey: "animation", label: "Animation" },
  {
    kind: "skybox-creator",
    keepKey: "skybox-creator",
    label: "Skybox Creator",
  },
  { kind: "trace", keepKey: "trace", label: "Trace" },
];

export type EngineSettingsCategoryId =
  | "about"
  | "appearance"
  | "undo"
  | "viewport"
  | "assets"
  | "thumbnails"
  | "templates"
  | "focus"
  | "graph";

export function EngineSettingsForm({
  settings,
  onChange,
  categoryId,
}: {
  settings: EngineSettings;
  onChange: (patch: Partial<EngineSettings>) => void | Promise<void>;
  categoryId: EngineSettingsCategoryId;
}) {
  const identity = getBuildIdentity();
  return (
    <FieldGroup data-testid="engine-settings-sheet">
      {categoryId === "about" ? (
        <FieldSet data-testid="build-identity">
          <FieldLegend>BabylonSlate</FieldLegend>
          {identity ? (
            <>
              <FieldDescription>
                <SelectableText>
                  Version {identity.applicationVersion} ·{" "}
                  {identity.channel === "test" ? "Test" : "Release"}
                </SelectableText>
              </FieldDescription>
              <FieldDescription>
                <SelectableText>
                  Windows {identity.windowsVersion} · Apple Build{" "}
                  {identity.appleBuildNumber}
                </SelectableText>
              </FieldDescription>
              <FieldDescription>
                <SelectableText>
                  Run {identity.runNumber} · Attempt {identity.runAttempt}
                </SelectableText>
              </FieldDescription>
              <FieldDescription>
                <SelectableText>{identity.sourceSha}</SelectableText>
              </FieldDescription>
            </>
          ) : (
            <FieldDescription>Development Build</FieldDescription>
          )}
        </FieldSet>
      ) : null}
      {categoryId === "appearance" ? (
        <FieldSet>
          <FieldLegend>Appearance</FieldLegend>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-theme">Theme</FieldLabel>
            <Select
              value={settings.appearance.theme}
              onValueChange={(value) =>
                void onChange({
                  appearance: {
                    ...settings.appearance,
                    theme: value as EngineSettings["appearance"]["theme"],
                  },
                })
              }
            >
              <SelectTrigger
                id="setting-theme"
                className="min-h-[var(--chrome-row,28px)] w-full"
                data-testid="setting-theme"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system" data-testid="setting-theme-system">
                  System
                </SelectItem>
                <SelectItem value="light" data-testid="setting-theme-light">
                  Light
                </SelectItem>
                <SelectItem value="dark" data-testid="setting-theme-dark">
                  Dark
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-pointer-scale">
              Touch Target Scale
            </FieldLabel>
            <NumberField
              id="setting-pointer-scale"
              min={1}
              step={0.1}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-pointer-scale"
              value={settings.appearance.coarsePointerTargetScale}
              onChange={(coarsePointerTargetScale) =>
                void onChange({
                  appearance: {
                    ...settings.appearance,
                    coarsePointerTargetScale,
                  },
                })
              }
            />
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "undo" ? (
        <FieldSet>
          <FieldLegend>Undo</FieldLegend>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-undo-length">
              Undo History Length
            </FieldLabel>
            <NumberField
              id="setting-undo-length"
              min={1}
              step={1}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-undo-length"
              value={settings.undoHistoryLength}
              onChange={(undoHistoryLength) =>
                void onChange({ undoHistoryLength })
              }
            />
            <FieldDescription>
              Maximum undo steps per document.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "viewport" ? (
        <FieldSet>
          <FieldLegend>Viewport</FieldLegend>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-frame-cap">
              Viewport Frame Cap (FPS)
            </FieldLabel>
            <NumberField
              id="setting-frame-cap"
              min={1}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-frame-cap"
              value={settings.viewportFrameCap}
              onChange={(viewportFrameCap) =>
                void onChange({ viewportFrameCap })
              }
            />
          </Field>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-fly-speed">Camera Speed</FieldLabel>
            <NumberField
              id="setting-fly-speed"
              min={0.0001}
              step={0.5}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-fly-speed"
              value={settings.viewportFlySpeed}
              onChange={(viewportFlySpeed) =>
                void onChange({ viewportFlySpeed })
              }
            />
            <FieldDescription>World units per second.</FieldDescription>
          </Field>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-hardware-scale">
              Hardware Scaling Level
            </FieldLabel>
            <NumberField
              id="setting-hardware-scale"
              min={0.25}
              step={0.25}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-hardware-scale"
              value={settings.hardwareScalingLevel}
              onChange={(hardwareScalingLevel) =>
                void onChange({ hardwareScalingLevel })
              }
            />
            <FieldDescription>
              1 is native resolution. Higher values reduce resolution.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal" className="settings-field">
            <FieldContent>
              <FieldLabel htmlFor="setting-post-processing">
                Post-Processing
              </FieldLabel>
              <FieldDescription>
                Editor and Play preview only; exported games are unchanged.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="setting-post-processing"
              data-testid="setting-post-processing"
              checked={settings.postProcessingEnabled}
              onCheckedChange={(checked) =>
                void onChange({ postProcessingEnabled: checked === true })
              }
            />
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "assets" ? (
        <FieldSet>
          <FieldLegend>Assets</FieldLegend>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-model-import-scale">
              Model Import Default Scale
            </FieldLabel>
            <NumberField
              id="setting-model-import-scale"
              min={0.0001}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-model-import-scale"
              value={settings.modelImportDefaultScale}
              onChange={(modelImportDefaultScale) =>
                void onChange({ modelImportDefaultScale })
              }
            />
            <FieldDescription>Applies to new imports only.</FieldDescription>
          </Field>
          <Field orientation="horizontal" className="settings-field">
            <FieldContent>
              <FieldLabel htmlFor="setting-editor-texture-lod">
                Editor Texture LOD
              </FieldLabel>
              <FieldDescription>
                Reduces texture resolution in the editor and Play preview.
                Export quality is unchanged.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="setting-editor-texture-lod"
              data-testid="setting-editor-texture-lod"
              checked={settings.editorTextureLodEnabled}
              onCheckedChange={(checked) =>
                void onChange({ editorTextureLodEnabled: checked === true })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="setting-editor-texture-lod-quality">
              Editor Texture Quality
            </FieldLabel>
            <Slider
              id="setting-editor-texture-lod-quality"
              data-testid="setting-editor-texture-lod-quality"
              min={25}
              max={100}
              step={5}
              value={[Math.round(settings.editorTextureLodQuality * 100)]}
              disabled={!settings.editorTextureLodEnabled}
              onValueChange={(value) => {
                const percent = Array.isArray(value) ? value[0] : value;
                if (typeof percent !== "number") return;
                void onChange({ editorTextureLodQuality: percent / 100 });
              }}
            />
            <FieldDescription>Percentage of source size.</FieldDescription>
          </Field>
          <Field orientation="horizontal" className="settings-field">
            <FieldContent>
              <FieldLabel htmlFor="setting-texture-budget">
                Texture Memory Budget
              </FieldLabel>
              <FieldDescription>
                Releases unused textures when memory use reaches the budget.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="setting-texture-budget"
              data-testid="setting-texture-budget"
              checked={settings.textureBudgetEnabled}
              onCheckedChange={(checked) =>
                void onChange({ textureBudgetEnabled: checked === true })
              }
            />
          </Field>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-texture-budget-mb">
              Texture Budget (MB)
            </FieldLabel>
            <NumberField
              id="setting-texture-budget-mb"
              min={256}
              max={8192}
              step={64}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-texture-budget-mb"
              value={Math.round(settings.textureByteCeiling / (1024 * 1024))}
              disabled={!settings.textureBudgetEnabled}
              onChange={(megabytes) =>
                void onChange({
                  textureByteCeiling: Math.round(megabytes) * 1024 * 1024,
                })
              }
            />
          </Field>
          <Field orientation="horizontal" className="settings-field">
            <FieldContent>
              <FieldLabel htmlFor="setting-audio-budget">
                Audio Memory Budget
              </FieldLabel>
              <FieldDescription>
                Releases unused audio clips when memory use reaches the budget.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="setting-audio-budget"
              data-testid="setting-audio-budget"
              checked={settings.audioBudgetEnabled}
              onCheckedChange={(checked) =>
                void onChange({ audioBudgetEnabled: checked === true })
              }
            />
          </Field>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-audio-budget-mb">
              Audio Budget (MB)
            </FieldLabel>
            <NumberField
              id="setting-audio-budget-mb"
              min={32}
              max={2048}
              step={16}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-audio-budget-mb"
              value={Math.round(settings.audioByteCeiling / (1024 * 1024))}
              disabled={!settings.audioBudgetEnabled}
              onChange={(megabytes) =>
                void onChange({
                  audioByteCeiling: Math.round(megabytes) * 1024 * 1024,
                })
              }
            />
          </Field>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-audio-max-voices">
              Max Concurrent Voices
            </FieldLabel>
            <NumberField
              id="setting-audio-max-voices"
              min={8}
              max={128}
              step={1}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-audio-max-voices"
              value={settings.audioMaxVoices}
              onChange={(audioMaxVoices) => void onChange({ audioMaxVoices })}
            />
            <FieldDescription>
              Stops the oldest voice when the limit is reached.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "thumbnails" ? (
        <FieldSet>
          <FieldLegend>Thumbnails</FieldLegend>
          <Field orientation="horizontal" className="settings-field">
            <FieldLabel htmlFor="setting-thumbnails">
              Generate Thumbnails
            </FieldLabel>
            <Switch
              id="setting-thumbnails"
              data-testid="setting-thumbnails"
              checked={settings.thumbnailsEnabled}
              onCheckedChange={(checked) =>
                void onChange({ thumbnailsEnabled: checked === true })
              }
            />
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "graph" ? (
        <FieldSet>
          <FieldLegend>Graph</FieldLegend>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-graph-default-zoom">
              Graph Default Zoom
            </FieldLabel>
            <NumberField
              id="setting-graph-default-zoom"
              min={0.1}
              max={1.5}
              step={0.05}
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-graph-default-zoom"
              value={settings.graphDefaultZoom}
              onChange={(graphDefaultZoom) =>
                void onChange({ graphDefaultZoom })
              }
            />
            <FieldDescription>
              Initial zoom and maximum zoom when fitting a graph.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "focus" ? (
        <FieldDescription>
          Keep these windows visible in Focus when they are open.
        </FieldDescription>
      ) : null}
      {categoryId === "focus"
        ? FOCUS_KEEP_SETTING_ROWS.map((row) => (
            <FocusKeepPanelList
              key={row.keepKey}
              kind={row.kind}
              keepKey={row.keepKey}
              label={row.label}
              options={row.options}
              ids={settings.focusKeepPanels[row.keepKey]}
              onChange={(ids) =>
                void onChange({
                  focusKeepPanels: {
                    ...settings.focusKeepPanels,
                    [row.keepKey]: ids,
                  },
                })
              }
            />
          ))
        : null}

      {categoryId === "templates" ? (
        <FieldSet>
          <FieldLegend>Templates</FieldLegend>
          <Field className="settings-field">
            <FieldLabel htmlFor="setting-templates-folder">
              Templates Folder
            </FieldLabel>
            <Input
              id="setting-templates-folder"
              type="text"
              className="min-h-[var(--chrome-row,28px)]"
              data-testid="setting-templates-folder"
              placeholder="Not available on web"
              value={settings.templatesFolder ?? ""}
              onChange={(event) =>
                void onChange({
                  templatesFolder: event.target.value
                    ? event.target.value
                    : null,
                })
              }
            />
            <FieldDescription>
              Folder containing Homepage templates.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}
    </FieldGroup>
  );
}

function focusKeepTitle(
  kind: FocusDocumentKind,
  id: string,
  options?: DockWindowOptions,
): string {
  return (
    focusKeepCandidates(kind, options).find((candidate) => candidate.id === id)
      ?.title ?? id
  );
}

function FocusKeepPanelList({
  kind,
  keepKey,
  label,
  ids,
  onChange,
  options,
}: {
  kind: FocusDocumentKind;
  keepKey: string;
  label: string;
  ids: string[];
  onChange: (ids: string[]) => void;
  options?: DockWindowOptions;
}) {
  const remaining = focusKeepCandidates(kind, options).filter(
    (candidate) => !ids.includes(candidate.id),
  );
  return (
    <FieldSet>
      <FieldLegend>{label}</FieldLegend>
      {ids.map((id) => {
        const title = focusKeepTitle(kind, id, options);
        return (
          <Field
            key={id}
            orientation="horizontal"
            data-testid={`focus-keep-${keepKey}-${id}`}
          >
            <FieldLabel>{title}</FieldLabel>
            <Button
              type="button"
              variant="ghost"
              size="touch-icon"
              aria-label={`Remove ${title}`}
              data-testid={`focus-keep-${keepKey}-remove-${id}`}
              onClick={() => onChange(ids.filter((entry) => entry !== id))}
            >
              <XIcon />
            </Button>
          </Field>
        );
      })}
      {remaining.length > 0 ? (
        <Field>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-[var(--chrome-row,28px)] w-full"
                  data-testid={`focus-keep-${keepKey}-add`}
                />
              }
            >
              <PlusIcon data-icon="inline-start" />
              Add Window
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              <DropdownMenuGroup>
                {remaining.map((candidate) => (
                  <DropdownMenuItem
                    key={candidate.id}
                    data-testid={`focus-keep-${keepKey}-add-${candidate.id}`}
                    onClick={() => onChange([...ids, candidate.id])}
                  >
                    {candidate.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
      ) : null}
    </FieldSet>
  );
}

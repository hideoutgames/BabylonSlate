import { NumberField } from "@babylonslate/editor-kit";
import type { EngineSettings } from "@babylonslate/vfs";
import { DEVICE_PRESETS } from "@babylonslate/ui-runtime";
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
    kind: "ui",
    keepKey: "ui",
    label: "User Interface Designer",
  },
  {
    kind: "ui",
    keepKey: "uiLogic",
    label: "User Interface Logic",
    options: { uiEditorMode: "logic" },
  },
  { kind: "anim-graph", keepKey: "anim-graph", label: "Animation Graph State Machine" },
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
  | "appearance"
  | "undo"
  | "viewport"
  | "assets"
  | "thumbnails"
  | "templates"
  | "focus"
  | "graph"
  | "ui";

export function EngineSettingsForm({
  settings,
  onChange,
  categoryId,
}: {
  settings: EngineSettings;
  onChange: (patch: Partial<EngineSettings>) => void | Promise<void>;
  categoryId: EngineSettingsCategoryId;
}) {
  return (
    <FieldGroup data-testid="engine-settings-sheet">
      {categoryId === "appearance" ? (
        <FieldSet>
          <FieldLegend>Appearance</FieldLegend>
          <Field>
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
                className="min-h-[var(--touch-target,44px)] w-full"
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
            <FieldDescription>
              Light, Dark, or match this device. Applies to chrome, the graph
              canvas, and the viewport background.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="setting-pointer-scale">
              Coarse pointer target scale
            </FieldLabel>
            <NumberField
              id="setting-pointer-scale"
              min={1}
              step={0.1}
              className="min-h-[var(--touch-target,44px)]"
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
            <FieldDescription>
              Multiplier for touch hit targets on this device. Graph pins and
              other `--touch-target` controls stay at 44px; chrome uses
              `--chrome-row`.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "undo" ? (
        <FieldSet>
          <FieldLegend>Undo</FieldLegend>
          <Field>
            <FieldLabel htmlFor="setting-undo-length">
              Undo history length
            </FieldLabel>
            <NumberField
              id="setting-undo-length"
              min={1}
              step={1}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-undo-length"
              value={settings.undoHistoryLength}
              onChange={(undoHistoryLength) =>
                void onChange({ undoHistoryLength })
              }
            />
            <FieldDescription>
              Per-document stack cap. Oldest entries drop first.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "viewport" ? (
        <FieldSet>
          <FieldLegend>Viewport</FieldLegend>
          <Field>
            <FieldLabel htmlFor="setting-frame-cap">
              Viewport frame cap
            </FieldLabel>
            <NumberField
              id="setting-frame-cap"
              min={1}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-frame-cap"
              value={settings.viewportFrameCap}
              onChange={(viewportFrameCap) =>
                void onChange({ viewportFrameCap })
              }
            />
            <FieldDescription>
              Caps scene and Prefab Preview while they are visible. Hidden
              tabs and open modals freeze rendering.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="setting-fly-speed">Camera Speed</FieldLabel>
            <NumberField
              id="setting-fly-speed"
              min={0.0001}
              step={0.5}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-fly-speed"
              value={settings.viewportFlySpeed}
              onChange={(viewportFlySpeed) =>
                void onChange({ viewportFlySpeed })
              }
            />
            <FieldDescription>
              Editor WASD and joystick fly speed in world units per second.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="setting-hardware-scale">
              Hardware scaling level
            </FieldLabel>
            <NumberField
              id="setting-hardware-scale"
              min={0.25}
              step={0.25}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-hardware-scale"
              value={settings.hardwareScalingLevel}
              onChange={(hardwareScalingLevel) =>
                void onChange({ hardwareScalingLevel })
              }
            />
            <FieldDescription>
              Editor viewport resolution scale. 1 is native; higher values
              render at a lower internal resolution.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="setting-post-processing">
                Post-processing
              </FieldLabel>
              <FieldDescription>
                Applies authored scene stacks in the editor viewport and Play
                preview. Off does not change the scene document or exported
                games.
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
          <Field>
            <FieldLabel htmlFor="setting-model-import-scale">
              Model Import Default Scale
            </FieldLabel>
            <NumberField
              id="setting-model-import-scale"
              min={0.0001}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-model-import-scale"
              value={settings.modelImportDefaultScale}
              onChange={(modelImportDefaultScale) =>
                void onChange({ modelImportDefaultScale })
              }
            />
            <FieldDescription>
              Multiplier stamped onto newly imported Models. Does not change
              models already in the project or scene scale.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="setting-editor-texture-lod">
                Editor Texture LOD
              </FieldLabel>
              <FieldDescription>
                Reduces large GPU textures in the editor and overlay Play. Small
                maps stay full size. Packed games use each Texture&apos;s
                Downsample setting.
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
            <FieldDescription>
              Percent of each texture&apos;s source size while LOD is on.
              Default 50%.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="setting-texture-budget">
                Texture Memory Budget
              </FieldLabel>
              <FieldDescription>
                Evicts unused GPU textures toward 80% of the budget. 512 MB is
                an iPad suggestion; the default is 2 GB.
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
          <Field>
            <FieldLabel htmlFor="setting-texture-budget-mb">
              Texture Budget (MB)
            </FieldLabel>
            <NumberField
              id="setting-texture-budget-mb"
              min={256}
              max={8192}
              step={64}
              className="min-h-[var(--touch-target,44px)]"
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
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="setting-audio-budget">
                Audio Memory Budget
              </FieldLabel>
              <FieldDescription>
                Evicts unused decoded clips. 64 MB is an iPad suggestion; the
                default is 256 MB. Audio document Preview is not this cache.
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
          <Field>
            <FieldLabel htmlFor="setting-audio-budget-mb">
              Audio Budget (MB)
            </FieldLabel>
            <NumberField
              id="setting-audio-budget-mb"
              min={32}
              max={2048}
              step={16}
              className="min-h-[var(--touch-target,44px)]"
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
          <Field>
            <FieldLabel htmlFor="setting-audio-max-voices">
              Max Concurrent Voices
            </FieldLabel>
            <NumberField
              id="setting-audio-max-voices"
              min={8}
              max={128}
              step={1}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-audio-max-voices"
              value={settings.audioMaxVoices}
              onChange={(audioMaxVoices) => void onChange({ audioMaxVoices })}
            />
            <FieldDescription>
              Oldest playing voice stops when the cap is exceeded. Default 32.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "thumbnails" ? (
        <FieldSet>
          <FieldLegend>Thumbnails</FieldLegend>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="setting-thumbnails">
              Generate thumbnails
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
          <Field>
            <FieldLabel htmlFor="setting-graph-default-zoom">
              Graph default zoom
            </FieldLabel>
            <NumberField
              id="setting-graph-default-zoom"
              min={0.1}
              max={1.5}
              step={0.05}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-graph-default-zoom"
              value={settings.graphDefaultZoom}
              onChange={(graphDefaultZoom) =>
                void onChange({ graphDefaultZoom })
              }
            />
            <FieldDescription>
              Opening zoom for node graphs. Fit-view will not zoom in past this
              value. Applies when a graph panel opens.
            </FieldDescription>
          </Field>
        </FieldSet>
      ) : null}

      {categoryId === "ui" ? (
        <UiDesignerPresetList
          presets={settings.uiDesignerPresets}
          onChange={(uiDesignerPresets) => void onChange({ uiDesignerPresets })}
        />
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
          <Field>
            <FieldLabel htmlFor="setting-templates-folder">
              Templates folder
            </FieldLabel>
            <Input
              id="setting-templates-folder"
              type="text"
              className="min-h-[var(--touch-target,44px)]"
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
              Template cards on the Homepage are discovered from this folder.
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
      <Field>
        <FieldDescription>
          Dock tabs that stay visible in Focus if they are already open. Closed
          tabs are not opened.
        </FieldDescription>
      </Field>
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
                  className="min-h-[var(--touch-target,44px)] w-full"
                  data-testid={`focus-keep-${keepKey}-add`}
                />
              }
            >
              <PlusIcon data-icon="inline-start" />
              Add tab to keep
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

type UiDesignerPreset = EngineSettings["uiDesignerPresets"][number];

function newCustomPresetId(): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now());
  return `custom-${suffix}`;
}

function UiDesignerPresetList({
  presets,
  onChange,
}: {
  presets: UiDesignerPreset[];
  onChange: (presets: UiDesignerPreset[]) => void;
}) {
  const patchPreset = (id: string, patch: Partial<UiDesignerPreset>) => {
    onChange(
      presets.map((preset) =>
        preset.id === id ? { ...preset, ...patch } : preset,
      ),
    );
  };
  return (
    <>
      <FieldSet>
        <FieldLegend>Built-In</FieldLegend>
        <Field>
          <FieldDescription>
            Stock UserInterface designer canvases. Add custom sizes below.
          </FieldDescription>
        </Field>
        {DEVICE_PRESETS.map((preset) => (
          <Field
            key={preset.id}
            orientation="horizontal"
            data-testid={`ui-preset-builtin-${preset.id}`}
          >
            <FieldLabel>{preset.label}</FieldLabel>
            <FieldDescription>
              {preset.width} × {preset.height}
            </FieldDescription>
          </Field>
        ))}
      </FieldSet>
      <FieldSet>
        <FieldLegend>Custom</FieldLegend>
        {presets.map((preset) => (
          <FieldGroup key={preset.id} data-testid={`ui-preset-custom-${preset.id}`}>
            <Field orientation="horizontal">
              <FieldLabel htmlFor={`ui-preset-label-${preset.id}`}>
                Name
              </FieldLabel>
              <Button
                type="button"
                variant="ghost"
                size="touch-icon"
                aria-label={`Remove ${preset.label}`}
                data-testid={`ui-preset-remove-${preset.id}`}
                onClick={() =>
                  onChange(presets.filter((entry) => entry.id !== preset.id))
                }
              >
                <XIcon />
              </Button>
            </Field>
            <Field>
              <Input
                id={`ui-preset-label-${preset.id}`}
                className="min-h-[var(--touch-target,44px)]"
                data-testid={`ui-preset-label-${preset.id}`}
                value={preset.label}
                onChange={(event) =>
                  patchPreset(preset.id, {
                    label: event.target.value.length > 0 ? event.target.value : "Custom",
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`ui-preset-width-${preset.id}`}>
                Width
              </FieldLabel>
              <NumberField
                id={`ui-preset-width-${preset.id}`}
                min={1}
                className="min-h-[var(--touch-target,44px)]"
                data-testid={`ui-preset-width-${preset.id}`}
                value={preset.width}
                onChange={(width) => patchPreset(preset.id, { width })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`ui-preset-height-${preset.id}`}>
                Height
              </FieldLabel>
              <NumberField
                id={`ui-preset-height-${preset.id}`}
                min={1}
                className="min-h-[var(--touch-target,44px)]"
                data-testid={`ui-preset-height-${preset.id}`}
                value={preset.height}
                onChange={(height) => patchPreset(preset.id, { height })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`ui-preset-safe-top-${preset.id}`}>
                Safe Top
              </FieldLabel>
              <NumberField
                id={`ui-preset-safe-top-${preset.id}`}
                min={0}
                className="min-h-[var(--touch-target,44px)]"
                data-testid={`ui-preset-safe-top-${preset.id}`}
                value={preset.safeArea.top}
                onChange={(top) =>
                  patchPreset(preset.id, {
                    safeArea: { ...preset.safeArea, top },
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`ui-preset-safe-right-${preset.id}`}>
                Safe Right
              </FieldLabel>
              <NumberField
                id={`ui-preset-safe-right-${preset.id}`}
                min={0}
                className="min-h-[var(--touch-target,44px)]"
                data-testid={`ui-preset-safe-right-${preset.id}`}
                value={preset.safeArea.right}
                onChange={(right) =>
                  patchPreset(preset.id, {
                    safeArea: { ...preset.safeArea, right },
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`ui-preset-safe-bottom-${preset.id}`}>
                Safe Bottom
              </FieldLabel>
              <NumberField
                id={`ui-preset-safe-bottom-${preset.id}`}
                min={0}
                className="min-h-[var(--touch-target,44px)]"
                data-testid={`ui-preset-safe-bottom-${preset.id}`}
                value={preset.safeArea.bottom}
                onChange={(bottom) =>
                  patchPreset(preset.id, {
                    safeArea: { ...preset.safeArea, bottom },
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`ui-preset-safe-left-${preset.id}`}>
                Safe Left
              </FieldLabel>
              <NumberField
                id={`ui-preset-safe-left-${preset.id}`}
                min={0}
                className="min-h-[var(--touch-target,44px)]"
                data-testid={`ui-preset-safe-left-${preset.id}`}
                value={preset.safeArea.left}
                onChange={(left) =>
                  patchPreset(preset.id, {
                    safeArea: { ...preset.safeArea, left },
                  })
                }
              />
            </Field>
          </FieldGroup>
        ))}
        <Field>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-[var(--touch-target,44px)] w-full"
            data-testid="ui-preset-add"
            onClick={() =>
              onChange([
                ...presets,
                {
                  id: newCustomPresetId(),
                  label: "Custom",
                  width: 1280,
                  height: 720,
                  safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
                },
              ])
            }
          >
            <PlusIcon data-icon="inline-start" />
            Add Preset
          </Button>
        </Field>
      </FieldSet>
    </>
  );
}

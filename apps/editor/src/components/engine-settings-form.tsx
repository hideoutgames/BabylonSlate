import { NumberField } from "@babylonslate/editor-kit";
import type { EngineSettings } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import { Switch } from "@babylonslate/ui/components/switch";
import {
  Field,
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

export type EngineSettingsCategoryId =
  | "appearance"
  | "undo"
  | "viewport"
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

      {categoryId === "focus" ? (
        <>
          <FocusKeepPanelList
            kind="scene"
            label="Scene"
            ids={settings.focusKeepPanels.scene}
            onChange={(scene) =>
              void onChange({
                focusKeepPanels: { ...settings.focusKeepPanels, scene },
              })
            }
          />
          <FocusKeepPanelList
            kind="graph"
            label="Class"
            ids={settings.focusKeepPanels.graph}
            onChange={(graph) =>
              void onChange({
                focusKeepPanels: { ...settings.focusKeepPanels, graph },
              })
            }
          />
        </>
      ) : null}

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

function focusKeepTitle(kind: FocusDocumentKind, id: string): string {
  return (
    focusKeepCandidates(kind).find((candidate) => candidate.id === id)?.title ??
    id
  );
}

function FocusKeepPanelList({
  kind,
  label,
  ids,
  onChange,
}: {
  kind: FocusDocumentKind;
  label: string;
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const remaining = focusKeepCandidates(kind).filter(
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
        const title = focusKeepTitle(kind, id);
        return (
          <Field
            key={id}
            orientation="horizontal"
            data-testid={`focus-keep-${kind}-${id}`}
          >
            <FieldLabel>{title}</FieldLabel>
            <Button
              type="button"
              variant="ghost"
              size="touch-icon"
              aria-label={`Remove ${title}`}
              data-testid={`focus-keep-${kind}-remove-${id}`}
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
                  data-testid={`focus-keep-${kind}-add`}
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
                    data-testid={`focus-keep-${kind}-add-${candidate.id}`}
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

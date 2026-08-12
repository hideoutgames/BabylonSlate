import { NumberField } from "@babylonslate/editor-kit";
import type { EngineSettings } from "@babylonslate/vfs";
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

export type EngineSettingsCategoryId =
  | "appearance"
  | "undo"
  | "viewport"
  | "thumbnails"
  | "templates";

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
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Stored on this machine. A runtime toggle is planned; the editor
              currently stays on the dark shell.
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
              Multiplier for touch hit targets on this device. Shell chrome
              still floors at 44px.
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

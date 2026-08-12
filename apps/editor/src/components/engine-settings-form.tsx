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
            <Input
              id="setting-pointer-scale"
              type="number"
              min={1}
              step={0.1}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-pointer-scale"
              value={settings.appearance.coarsePointerTargetScale}
              onChange={(event) =>
                void onChange({
                  appearance: {
                    ...settings.appearance,
                    coarsePointerTargetScale:
                      Number(event.target.value) || 1,
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
            <Input
              id="setting-undo-length"
              type="number"
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-undo-length"
              value={settings.undoHistoryLength}
              onChange={(event) =>
                void onChange({
                  undoHistoryLength: Number(event.target.value) || 50,
                })
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
            <Input
              id="setting-frame-cap"
              type="number"
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-frame-cap"
              value={settings.viewportFrameCap}
              onChange={(event) =>
                void onChange({
                  viewportFrameCap: Number(event.target.value) || 60,
                })
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
            <Input
              id="setting-hardware-scale"
              type="number"
              min={0.25}
              step={0.25}
              className="min-h-[var(--touch-target,44px)]"
              data-testid="setting-hardware-scale"
              value={settings.hardwareScalingLevel}
              onChange={(event) =>
                void onChange({
                  hardwareScalingLevel: Number(event.target.value) || 1,
                })
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

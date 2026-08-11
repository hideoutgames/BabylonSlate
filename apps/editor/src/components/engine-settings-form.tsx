import type { EngineSettings } from "@babylonslate/vfs";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";

export function EngineSettingsForm({
  settings,
  onChange,
}: {
  settings: EngineSettings;
  onChange: (patch: Partial<EngineSettings>) => void | Promise<void>;
}) {
  return (
    <FieldGroup className="px-4 pb-4" data-testid="engine-settings-sheet">
      <Field>
        <FieldLabel htmlFor="setting-undo-length">Undo history length</FieldLabel>
        <Input
          id="setting-undo-length"
          type="number"
          data-testid="setting-undo-length"
          value={settings.undoHistoryLength}
          onChange={(event) =>
            void onChange({ undoHistoryLength: Number(event.target.value) || 50 })
          }
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="setting-frame-cap">Viewport frame cap</FieldLabel>
        <Input
          id="setting-frame-cap"
          type="number"
          data-testid="setting-frame-cap"
          value={settings.viewportFrameCap}
          onChange={(event) =>
            void onChange({ viewportFrameCap: Number(event.target.value) || 60 })
          }
        />
      </Field>
      <Field orientation="horizontal">
        <Checkbox
          id="setting-thumbnails"
          data-testid="setting-thumbnails"
          checked={settings.thumbnailsEnabled}
          onCheckedChange={(checked) =>
            void onChange({ thumbnailsEnabled: checked === true })
          }
        />
        <FieldLabel htmlFor="setting-thumbnails">Generate thumbnails</FieldLabel>
      </Field>
      <Field>
        <FieldLabel htmlFor="setting-templates-folder">Templates folder</FieldLabel>
        <Input
          id="setting-templates-folder"
          type="text"
          data-testid="setting-templates-folder"
          placeholder="Not available on web"
          value={settings.templatesFolder ?? ""}
          onChange={(event) =>
            void onChange({
              templatesFolder: event.target.value ? event.target.value : null,
            })
          }
        />
        <FieldDescription>
          Template cards on the Homepage are discovered from this folder.
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}

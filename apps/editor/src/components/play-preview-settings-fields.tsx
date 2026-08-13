import type { PlayPreviewProjectSettings } from "@babylonslate/core";
import { NumberField } from "@babylonslate/editor-kit";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Switch } from "@babylonslate/ui/components/switch";

export function PlayPreviewSettingsFields({
  settings,
  onChange,
}: {
  settings: PlayPreviewProjectSettings;
  onChange: (playPreview: PlayPreviewProjectSettings) => void;
}) {
  const aspectDisabled = settings.followSystem;
  return (
    <>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="setting-play-follow-system">
          Follow System
        </FieldLabel>
        <Switch
          id="setting-play-follow-system"
          checked={settings.followSystem}
          onCheckedChange={(checked) =>
            onChange({ ...settings, followSystem: checked === true })
          }
          data-testid="setting-play-follow-system"
        />
      </Field>
      <FieldDescription>
        Fill the Play overlay. Turn off to letterbox a fixed aspect ratio.
      </FieldDescription>
      <Field>
        <FieldLabel htmlFor="setting-play-aspect-width">
          Aspect Ratio
        </FieldLabel>
        <div className="flex items-center gap-2">
          <NumberField
            id="setting-play-aspect-width"
            min={1}
            step={1}
            disabled={aspectDisabled}
            className="min-h-[var(--touch-target,44px)]"
            value={settings.aspectWidth}
            onChange={(aspectWidth) => onChange({ ...settings, aspectWidth })}
            data-testid="setting-play-aspect-width"
            aria-label="Aspect Width"
          />
          <span aria-hidden="true">:</span>
          <NumberField
            id="setting-play-aspect-height"
            min={1}
            step={1}
            disabled={aspectDisabled}
            className="min-h-[var(--touch-target,44px)]"
            value={settings.aspectHeight}
            onChange={(aspectHeight) =>
              onChange({ ...settings, aspectHeight })
            }
            data-testid="setting-play-aspect-height"
            aria-label="Aspect Height"
          />
        </div>
        <FieldDescription>
          Letterboxes Play Preview. Unused overlay space is black.
        </FieldDescription>
      </Field>
    </>
  );
}

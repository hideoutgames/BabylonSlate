import type { PlayPreviewProjectSettings } from "@haptic/core";
import { LabelHint, NumberField } from "@haptic/editor-kit";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Switch } from "@haptic/ui/components/switch";

const FOLLOW_SYSTEM_HINT = "Off uses a fixed aspect ratio.";

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
      <Field orientation="horizontal" className="settings-field">
        <LabelHint hint={FOLLOW_SYSTEM_HINT}>
          <FieldLabel htmlFor="setting-play-follow-system">
            Follow System
          </FieldLabel>
        </LabelHint>
        <Switch
          id="setting-play-follow-system"
          aria-describedby="setting-play-follow-system-description"
          checked={settings.followSystem}
          onCheckedChange={(checked) =>
            onChange({ ...settings, followSystem: checked === true })
          }
          data-testid="setting-play-follow-system"
        />
        <FieldDescription id="setting-play-follow-system-description" className="sr-only">
          {FOLLOW_SYSTEM_HINT}
        </FieldDescription>
      </Field>
      <Field className="settings-field settings-field-dependent" data-disabled={aspectDisabled}>
        <FieldLabel htmlFor="setting-play-aspect-width">
          Aspect Ratio
        </FieldLabel>
        <div className="flex items-center gap-2">
          <NumberField
            id="setting-play-aspect-width"
            min={1}
            step={1}
            disabled={aspectDisabled}
            className="min-h-[var(--chrome-row,28px)]"
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
            className="min-h-[var(--chrome-row,28px)]"
            value={settings.aspectHeight}
            onChange={(aspectHeight) => onChange({ ...settings, aspectHeight })}
            data-testid="setting-play-aspect-height"
            aria-label="Aspect Height"
          />
        </div>
      </Field>
    </>
  );
}

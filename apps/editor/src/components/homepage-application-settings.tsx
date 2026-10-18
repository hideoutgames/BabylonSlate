import { getHostPlatform } from "@babylonslate/vfs";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@babylonslate/ui/components/field";
import { Switch } from "@babylonslate/ui/components/switch";
import { useAppSettings } from "../context/app-settings-context";

/** Application-wide preferences for the Account dialog's Application section. */
export function ApplicationSettingsFields() {
  const { settings, hydrated, updateSettings } = useAppSettings();
  const desktop = getHostPlatform() === "electron";
  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend>Updates</FieldLegend>
        <Field orientation="horizontal" className="settings-field">
          <FieldContent>
            <FieldLabel htmlFor="application-auto-update">
              Automatic Updates
            </FieldLabel>
            <FieldDescription>
              {desktop
                ? "Download new releases from GitHub and install them when you exit Haptic. Also available in Engine Settings."
                : "Automatic updates are managed here in the desktop app."}
            </FieldDescription>
          </FieldContent>
          <Switch
            id="application-auto-update"
            data-testid="application-auto-update"
            checked={settings.automaticUpdatesEnabled}
            disabled={!desktop || !hydrated}
            onCheckedChange={(checked) =>
              void updateSettings(settings => {
                settings.automaticUpdatesEnabled = checked;
              })
            }
          />
        </Field>
      </FieldSet>
    </FieldGroup>
  );
}

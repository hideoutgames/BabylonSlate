import { useState } from "react";
import { LabelHint } from "@haptic/editor-kit";
import { Field, FieldDescription, FieldError, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { getElectronGameShellBridge, type EngineSettings } from "@haptic/vfs";
import { SettingsSection } from "./settings-section";

/**
 * Engine Settings → Packaging → iOS: the Apple Developer team Xcode's
 * automatic signing uses for packaged iOS games. Only the desktop app on a
 * Mac builds them. A typed Team ID is kept as a draft until it has its ten
 * characters, so an unfinished one never replaces the saved one.
 */
export function IosSigningSettings({ settings, onChange }: {
  settings: EngineSettings["iosSigning"];
  onChange(iosSigning: EngineSettings["iosSigning"]): void;
}) {
  const bridge = getElectronGameShellBridge();
  const [draft, setDraft] = useState<string | null>(null);
  if (bridge?.platform !== "darwin" || !bridge.packageIos) {
    return (
      <SettingsSection id="iosSigning" title="iOS">
        <FieldDescription className="settings-row" data-testid="ios-signing-unavailable">
          iOS games are packaged in the Haptic desktop app on a Mac.
        </FieldDescription>
      </SettingsSection>
    );
  }
  const text = draft ?? settings.teamId;
  const incomplete = text.length > 0 && text.length < 10;
  return (
    <SettingsSection id="iosSigning" title="iOS">
      <Field className="settings-field" data-invalid={incomplete ? true : undefined}>
        <LabelHint hint="Your team's ID from the Apple Developer website's Membership page; sign in to Xcode with the same account.">
          <FieldLabel htmlFor="setting-ios-team">Team ID</FieldLabel>
        </LabelHint>
        <div className="flex min-w-0 flex-col gap-1">
          <Input
            id="setting-ios-team"
            data-testid="setting-ios-team"
            className="font-mono text-xs"
            value={text}
            maxLength={10}
            aria-invalid={incomplete ? true : undefined}
            aria-describedby={incomplete ? "setting-ios-team-error" : undefined}
            onChange={(event) => {
              const next = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
              setDraft(next);
              if (next.length === 0 || next.length === 10) onChange({ teamId: next });
            }}
            onBlur={() => setDraft(null)}
          />
          {incomplete ? <FieldError id="setting-ios-team-error">A Team ID has ten letters and digits.</FieldError> : null}
        </div>
      </Field>
    </SettingsSection>
  );
}

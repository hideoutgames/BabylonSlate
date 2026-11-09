import { useEffect, useState } from "react";
import { LabelHint } from "@haptic/editor-kit";
import { Field, FieldDescription, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { getElectronGameShellBridge, type EngineSettings } from "@haptic/vfs";
import { SettingsSection } from "./settings-section";

const AD_HOC = "ad-hoc";

/**
 * Engine Settings → Packaging → macOS Signing: the Developer ID identity from
 * this Mac's keychain that signs packaged macOS games, and the notarytool
 * keychain profile that notarizes them. Only the desktop app on a Mac signs.
 */
export function MacSigningSettings({ settings, onChange }: {
  settings: EngineSettings["macSigning"];
  onChange(macSigning: EngineSettings["macSigning"]): void;
}) {
  const bridge = getElectronGameShellBridge();
  const onMac = bridge?.platform === "darwin";
  const [identities, setIdentities] = useState<string[] | null>(null);
  useEffect(() => {
    if (!onMac || !bridge) return;
    let current = true;
    void bridge.macIdentities().then(
      (list) => { if (current) setIdentities(list); },
      () => { if (current) setIdentities([]); },
    );
    return () => { current = false; };
  }, [bridge, onMac]);

  if (!onMac) {
    return (
      <SettingsSection id="macSigning" title="macOS Signing">
        <FieldDescription className="settings-row" data-testid="mac-signing-unavailable">
          macOS games are signed in the Haptic desktop app on a Mac.
        </FieldDescription>
      </SettingsSection>
    );
  }
  // A saved identity stays listed while the keychain is read, or after it was removed, so it is visible and can be changed.
  const listed = [...new Set([...(identities ?? []), ...(settings.identity ? [settings.identity] : [])])];
  const items = [{ value: AD_HOC, label: "Ad-Hoc (Local Testing)" }, ...listed.map((identity) => ({ value: identity, label: identity.replace(/^Developer ID Application: /, "") }))];
  const missing = settings.identity !== null && identities !== null && !identities.includes(settings.identity);
  return (
    <SettingsSection id="macSigning" title="macOS Signing">
      <Field className="settings-field" data-invalid={missing ? true : undefined}>
        <LabelHint hint="A Developer ID Application certificate in this Mac's keychain. Ad-hoc signed games open only on Macs where you allow them.">
          <FieldLabel htmlFor="setting-mac-signing-identity">Signing Identity</FieldLabel>
        </LabelHint>
        <Select
          items={items}
          value={settings.identity ?? AD_HOC}
          onValueChange={(value) => onChange({ ...settings, identity: value === AD_HOC || typeof value !== "string" ? null : value })}
        >
          <SelectTrigger id="setting-mac-signing-identity" size="sm" className="w-full" data-testid="setting-mac-signing-identity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {missing ? (
        <FieldDescription className="settings-row text-(--warning)" data-testid="mac-signing-missing">
          This identity is not in this Mac's keychain.
        </FieldDescription>
      ) : null}
      <Field className="settings-field">
        <LabelHint hint="The profile name you gave xcrun notarytool store-credentials. Empty skips notarization.">
          <FieldLabel htmlFor="setting-mac-notary-profile">Notarization Profile</FieldLabel>
        </LabelHint>
        <Input
          id="setting-mac-notary-profile"
          data-testid="setting-mac-notary-profile"
          value={settings.notaryProfile}
          disabled={settings.identity === null}
          maxLength={128}
          onChange={(event) => {
            const notaryProfile = event.target.value.replace(/[^A-Za-z0-9._-]/g, "");
            onChange({ ...settings, notaryProfile });
          }}
        />
      </Field>
    </SettingsSection>
  );
}

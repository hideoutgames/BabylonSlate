import { useEffect, useState } from "react";
import { LabelHint } from "@haptic/editor-kit";
import { ANDROID_SIGNING_SECRETS } from "@haptic/exporter/native-android";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { getElectronGameShellBridge, getElectronSecretsBridge, type AndroidPackagingChange } from "@haptic/vfs";
import { useAndroidPackaging } from "../lib/android-packaging";
import { SettingsSection } from "./settings-section";

type Picked = "java" | "sdk" | "keystore";

/** A chosen path shown read-only, with Choose… and a way back to finding it. */
function PathRow({ id, label, hint, value, placeholder, resetLabel, disabled, onChange }: {
  id: string;
  label: string;
  hint: string;
  value: string | null;
  placeholder: string;
  resetLabel: string;
  disabled: boolean;
  onChange: (change: AndroidPackagingChange) => void;
}) {
  const key = id.replace("setting-android-", "") as Picked;
  return (
    <Field className="settings-field">
      <LabelHint hint={hint}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </LabelHint>
      <div className="flex min-w-0 items-center gap-1">
        <Input id={id} data-testid={id} readOnly value={value ?? ""} placeholder={placeholder} className="min-w-0 flex-1 font-mono text-xs" />
        <Button variant="outline" size="sm" disabled={disabled} data-testid={`${id}-choose`} onClick={() => onChange({ pick: key })}>
          Choose…
        </Button>
        {value ? (
          <Button variant="ghost" size="sm" disabled={disabled} data-testid={`${id}-reset`} onClick={() => onChange({ clear: key })}>
            {resetLabel}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

/** A password kept in this computer's secret store: shown only as Saved; leaving the field saves what was typed. */
function SecretRow({ id, label, hint, secretKey, disabled }: { id: string; label: string; hint: string; secretKey: string; disabled: boolean }) {
  const secrets = getElectronSecretsBridge();
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    let current = true;
    void secrets?.get(secretKey).then((value) => { if (current) setSaved(Boolean(value)); }, () => {});
    return () => { current = false; };
  }, [secrets, secretKey]);
  const save = async () => {
    if (!draft || !secrets) return;
    await secrets.set(secretKey, draft);
    setDraft("");
    setSaved(true);
  };
  return (
    <Field className="settings-field">
      <LabelHint hint={hint}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </LabelHint>
      <Input
        id={id}
        data-testid={id}
        type="password"
        autoComplete="off"
        value={draft}
        placeholder={saved ? "Saved" : ""}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => { if (event.key === "Enter") void save(); }}
      />
    </Field>
  );
}

/**
 * Engine Settings → Packaging → Android: the JDK and Android SDK that build
 * Android games and the keystore that signs them. The desktop app's main
 * process keeps the paths, chosen in its own pickers; the passwords are in
 * this computer's secret store. Android games are packaged only there.
 */
export function AndroidPackagingSettings() {
  const available = Boolean(getElectronGameShellBridge()?.androidSettings);
  const { status, error, change } = useAndroidPackaging(available);
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);

  if (!available) {
    return (
      <SettingsSection id="android" title="Android">
        <FieldDescription className="settings-row" data-testid="android-packaging-unavailable">
          Android games are packaged in the Haptic desktop app.
        </FieldDescription>
      </SettingsSection>
    );
  }
  const loading = status === null;
  const problems = [...(status?.toolchain.problems ?? []), ...(error ? [error] : [])];
  const debugKey = status?.keystore === null;
  const commitAlias = () => {
    if (aliasDraft !== null && aliasDraft.trim() !== status?.alias) void change({ alias: aliasDraft.trim() });
    setAliasDraft(null);
  };
  return (
    <SettingsSection id="android" title="Android">
      <PathRow
        id="setting-android-java"
        label="JDK"
        hint="Java 17 or later; without a choice, JAVA_HOME or Android Studio's JDK."
        value={status?.java ?? null}
        placeholder={status?.toolchain.javaHome ?? (loading ? "" : "Not Found")}
        resetLabel="Find Automatically"
        disabled={loading}
        onChange={(next) => void change(next)}
      />
      <PathRow
        id="setting-android-sdk"
        label="Android SDK"
        hint="Without a choice, ANDROID_HOME or Android Studio's SDK folder is used."
        value={status?.sdk ?? null}
        placeholder={status?.toolchain.sdk ?? (loading ? "" : "Not Found")}
        resetLabel="Find Automatically"
        disabled={loading}
        onChange={(next) => void change(next)}
      />
      {problems.length > 0 ? (
        <FieldError className="settings-row" data-testid="android-toolchain-problems">{problems.join(" ")}</FieldError>
      ) : null}
      <PathRow
        id="setting-android-keystore"
        label="Keystore"
        hint="Your upload or release key; without one, games are signed with Android's debug key for testing."
        value={status?.keystore ?? null}
        placeholder="Debug Key (Testing Only)"
        resetLabel="Use Debug Key"
        disabled={loading}
        onChange={(next) => void change(next)}
      />
      <Field className="settings-field">
        <FieldLabel htmlFor="setting-android-alias">Key Alias</FieldLabel>
        <Input
          id="setting-android-alias"
          data-testid="setting-android-alias"
          value={aliasDraft ?? status?.alias ?? ""}
          maxLength={256}
          disabled={loading || debugKey}
          onChange={(event) => setAliasDraft(event.target.value)}
          onBlur={commitAlias}
          onKeyDown={(event) => { if (event.key === "Enter") commitAlias(); }}
        />
      </Field>
      <SecretRow
        id="setting-android-store-password"
        label="Keystore Password"
        hint="Kept in this computer's secret store."
        secretKey={ANDROID_SIGNING_SECRETS.store}
        disabled={loading || debugKey}
      />
      <SecretRow
        id="setting-android-key-password"
        label="Key Password"
        hint="Leave empty when the key uses the keystore password."
        secretKey={ANDROID_SIGNING_SECRETS.key}
        disabled={loading || debugKey}
      />
    </SettingsSection>
  );
}

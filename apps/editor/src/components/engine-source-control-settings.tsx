import { useEffect, useState } from "react";
import { PlusIcon } from "lucide-react";
import {
  GITHUB_ORIGIN,
  GITLAB_ORIGIN,
  hostOrigin,
  type HostCredential,
} from "@haptic/source-control";
import type { DeviceSignInHost } from "@haptic/source-control/device-flow";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldError, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { isTestModeEnabled } from "@haptic/vfs";
import { deviceClientId } from "../lib/source-control-client-ids";
import { useSourceControlCredentials } from "../lib/use-source-control-credentials";
import { SessionSecretsNotice } from "./session-secrets-notice";
import { SettingsSection } from "./settings-section";
import { useHostLink, type HostLinkRequest } from "./use-host-link";

const ACCOUNT_HOSTS: Array<{ host: DeviceSignInHost; origin: string; label: string }> = [
  { host: "github", origin: GITHUB_ORIGIN, label: "GitHub" },
  { host: "gitlab", origin: GITLAB_ORIGIN, label: "GitLab" },
];

/** A typed host and token, saved after the link warning is accepted. */
function TokenForm({
  idPrefix,
  hostLabel,
  actionLabel,
  credentialKind,
  link,
}: {
  idPrefix: string;
  hostLabel: string;
  actionLabel: string;
  credentialKind: "gitlab-token" | "token";
  link: (request: HostLinkRequest) => Promise<boolean>;
}) {
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const origin = hostOrigin(host);
  const save = async () => {
    if (!origin || !token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (await link({ kind: "token", origin, token: token.trim(), credentialKind })) {
        setHost("");
        setToken("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const hostInvalid = host.trim() !== "" && !origin;
  return (
    <>
      <Field className="settings-field" data-invalid={hostInvalid || undefined}>
        <FieldLabel htmlFor={`${idPrefix}-url`}>{hostLabel}</FieldLabel>
        <Input
          id={`${idPrefix}-url`}
          data-testid={`${idPrefix}-url`}
          value={host}
          placeholder="https://"
          autoComplete="off"
          aria-invalid={hostInvalid || undefined}
          onChange={(event) => setHost(event.target.value)}
        />
        {hostInvalid ? <FieldError>Enter an HTTPS URL.</FieldError> : null}
      </Field>
      <Field className="settings-field" data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={`${idPrefix}-token`}>Token</FieldLabel>
        <Input
          id={`${idPrefix}-token`}
          data-testid={`${idPrefix}-token`}
          type="password"
          autoComplete="off"
          value={token}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setError(null);
            setToken(event.target.value);
          }}
        />
        {error ? <FieldError data-testid={`${idPrefix}-error`}>{error}</FieldError> : null}
      </Field>
      <Field orientation="horizontal" className="settings-field">
        <FieldLabel className="sr-only">{actionLabel}</FieldLabel>
        <Button
          variant="outline"
          size="sm"
          className="w-fit justify-self-end"
          data-testid={`${idPrefix}-save`}
          disabled={busy || !origin || !token.trim()}
          onClick={() => void save()}
        >
          {credentialKind === "token" ? <PlusIcon data-icon="inline-start" /> : null}
          {actionLabel}
        </Button>
      </Field>
    </>
  );
}

function SavedHostRow({ credential, refused, onRemove }: { credential: HostCredential; refused: boolean; onRemove: () => void }) {
  const host = new URL(credential.origin).host;
  return (
    <Field orientation="horizontal" className="settings-field" data-testid={`settings-source-control-host-${host}`}>
      <FieldLabel>{host}</FieldLabel>
      <div className="flex min-w-0 items-center justify-end gap-2">
        <span className={refused ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{refused ? "Token Refused" : "Token Saved"}</span>
        <Button variant="outline" size="sm" aria-label={`Remove ${host}`} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </Field>
  );
}

/**
 * Engine Settings → Source Control: this device's GitHub and GitLab sign-ins
 * and host tokens, one per host. Loaded on first open of the page, which asks
 * each host once whether its saved sign-in still works; one the host refused,
 * or past its expiry, says so and offers Sign In Again.
 */
export default function EngineSourceControlSettings() {
  const { accounts, credentials, error } = useSourceControlCredentials();
  const { link, dialogs } = useHostLink();
  const testMode = isTestModeEnabled();
  const remove = (origin: string) => void accounts?.remove(origin);
  const stateOf = (credential: HostCredential) => accounts?.signInState(credential) ?? "signed-in";
  useEffect(() => {
    void accounts?.checkSignIns();
  }, [accounts]);
  const accountRows = ACCOUNT_HOSTS.flatMap((entry) => {
    const credential = credentials.find((candidate) => candidate.origin === entry.origin && candidate.kind === entry.host);
    // Without a client id a host offers no Sign In, but an existing sign-in can still sign out.
    return credential || deviceClientId(entry.host, testMode) ? [{ ...entry, credential }] : [];
  });
  return (
    <>
      {error ? <FieldError className="settings-row">{error}</FieldError> : null}
      <SessionSecretsNotice />
      {accountRows.length > 0 ? (
        <SettingsSection id="accounts" title="Accounts">
          {accountRows.map(({ host, label, origin, credential }) => {
            const state = credential ? stateOf(credential) : "signed-in";
            const canSignIn = deviceClientId(host, testMode) !== null;
            return (
              <Field key={host} orientation="horizontal" className="settings-field" data-testid={`settings-source-control-account-${host}`}>
                <FieldLabel>{label}</FieldLabel>
                <div className="flex min-w-0 items-center justify-end gap-2">
                  {credential ? (
                    <>
                      <span
                        className={state === "signed-in" ? "min-w-0 truncate text-xs text-muted-foreground" : "min-w-0 truncate text-xs text-destructive"}
                        data-testid={`settings-source-control-account-${host}-user`}
                      >
                        {state === "refused" ? "Sign-In Refused" : state === "expired" ? "Sign-In Expired" : credential.account ?? "Signed In"}
                      </span>
                      {state !== "signed-in" && canSignIn ? (
                        <Button size="sm" data-testid={`settings-source-control-sign-in-again-${host}`} onClick={() => void link({ kind: "sign-in", host })}>
                          Sign In Again
                        </Button>
                      ) : null}
                      <Button variant="outline" size="sm" data-testid={`settings-source-control-sign-out-${host}`} onClick={() => remove(origin)}>
                        Sign Out
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" data-testid={`settings-source-control-sign-in-${host}`} onClick={() => void link({ kind: "sign-in", host })}>
                      Sign In
                    </Button>
                  )}
                </div>
              </Field>
            );
          })}
        </SettingsSection>
      ) : null}
      <SettingsSection id="selfManagedGitLab" title="Self-Managed GitLab">
        {credentials.filter((credential) => credential.kind === "gitlab-token").map((credential) => (
          <SavedHostRow key={credential.origin} credential={credential} refused={stateOf(credential) === "refused"} onRemove={() => remove(credential.origin)} />
        ))}
        <TokenForm idPrefix="settings-source-control-gitlab" hostLabel="Instance URL" actionLabel="Save Token" credentialKind="gitlab-token" link={link} />
      </SettingsSection>
      <SettingsSection id="otherHosts" title="Other Git Hosts">
        {credentials.filter((credential) => credential.kind === "token").map((credential) => (
          <SavedHostRow key={credential.origin} credential={credential} refused={stateOf(credential) === "refused"} onRemove={() => remove(credential.origin)} />
        ))}
        <TokenForm idPrefix="settings-source-control-host" hostLabel="Host URL" actionLabel="Add Host" credentialKind="token" link={link} />
      </SettingsSection>
      {dialogs}
    </>
  );
}

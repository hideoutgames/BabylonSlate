import { useEffect, useState } from "react";
import { CircleAlertIcon } from "lucide-react";
import { credentialHasHostApi } from "@haptic/source-control";
import type { DeviceSignInHost } from "@haptic/source-control/device-flow";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { isTestModeEnabled } from "@haptic/vfs";
import { deviceClientId } from "../lib/source-control-client-ids";
import { API_HOSTS, repositoryNameFor, useAccountApi, useHostOwners } from "../lib/source-control-host-accounts";
import { useSourceControlCredentials } from "../lib/use-source-control-credentials";
import { signInPromptFor } from "../services/source-control-service";
import type { NewRepositoryRequest } from "../services/source-control-publish";
import { useHostLink } from "./use-host-link";

const SIGN_IN_HOSTS: DeviceSignInHost[] = ["github", "gitlab"];

/**
 * New Project's Remote fields (loaded when Remote is chosen, with the
 * device's accounts): the signed-in host account that creates the repository
 * (GitHub, GitLab or a self-managed GitLab; a host without a REST API cannot
 * create one), its Owner, the Repository Name, which follows the project's
 * name until edited, and Private or Public. With no such account it offers
 * Sign In To GitHub / GitLab (the link warning, then device sign-in). The
 * repository to create, or null while one is missing, goes to
 * `onRequestChange`; the project opens, then Publish creates it.
 */
export default function NewProjectRepositoryFields({
  projectName,
  preferredOrigin,
  disabled,
  onRequestChange,
}: {
  projectName: string;
  /** The host account the last Remote project used on this device; another one when it is no longer signed in. */
  preferredOrigin: string;
  disabled: boolean;
  /** Called after each change of the request; keep it stable (a state setter), as each new identity reports again. */
  onRequestChange: (request: NewRepositoryRequest | null) => void;
}) {
  const { accounts, credentials } = useSourceControlCredentials();
  const { link, dialogs } = useHostLink();
  const hostAccounts = credentials.filter((credential) => credentialHasHostApi(credential.kind));
  const [chosenOrigin, setChosenOrigin] = useState<string | null>(null);
  const credential = hostAccounts.find((entry) => entry.origin === chosenOrigin)
    ?? hostAccounts.find((entry) => entry.origin === preferredOrigin)
    ?? hostAccounts[0]
    ?? null;
  const { api } = useAccountApi(accounts, credential);
  const { owners, error: ownersError } = useHostOwners(api);
  /** The owner chosen by name; until then, the first (the signed-in user). */
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const owner = owners?.find((entry) => entry.name === ownerName) ?? owners?.[0] ?? null;
  /** Null follows the project's name. */
  const [editedName, setEditedName] = useState<string | null>(null);
  const name = editedName ?? repositoryNameFor(projectName);
  const trimmed = name.trim();
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const testMode = isTestModeEnabled();
  const signInHosts = SIGN_IN_HOSTS.filter((host) => deviceClientId(host, testMode) !== null);

  const reason = !accounts
    ? "Loading accounts…"
    : !credential
      ? signInHosts.length > 0
        ? "Sign in to a Git host to create the repository."
        : "Add a Git host account in Engine Settings > Source Control."
      : ownersError
        ? ownersError
        : !owner
          ? "Loading owners…"
          : !trimmed
            ? "Enter a repository name."
            : null;
  const origin = credential?.origin ?? null;
  const isPrivate = visibility === "private";
  useEffect(() => {
    onRequestChange(reason === null && origin && owner ? { origin, owner, name: trimmed, private: isPrivate } : null);
  }, [isPrivate, onRequestChange, origin, owner, reason, trimmed]);

  return (
    <FieldGroup className="gap-3" data-testid="create-project-remote">
      {accounts && !credential && signInHosts.length > 0 ? (
        <Field>
          <FieldLabel>Host</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {signInHosts.map((host) => {
              const Icon = API_HOSTS[host].icon;
              return (
                <Button
                  key={host}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  data-testid={`create-project-remote-sign-in-${host}`}
                  onClick={() => void link({ kind: "sign-in", host })}
                >
                  <Icon data-icon="inline-start" />
                  Sign In To {API_HOSTS[host].label}
                </Button>
              );
            })}
          </div>
        </Field>
      ) : credential ? (
        <>
          <Field>
            <FieldLabel htmlFor="create-project-remote-host">Host</FieldLabel>
            <Select value={credential.origin} disabled={disabled} onValueChange={(value) => { if (value) setChosenOrigin(String(value)); }}>
              <SelectTrigger id="create-project-remote-host" className="w-full" data-testid="create-project-remote-host">
                <SelectValue>{hostAccountLabel(credential)}</SelectValue>
              </SelectTrigger>
              <SelectContent className="homepage-theme">
                <SelectGroup>
                  {hostAccounts.map((entry) => (
                    <SelectItem key={entry.origin} value={entry.origin}>{hostAccountLabel(entry)}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="create-project-remote-owner">Owner</FieldLabel>
            <Select value={owner?.name ?? null} disabled={disabled || !owners} onValueChange={(value) => setOwnerName(value ? String(value) : null)}>
              <SelectTrigger id="create-project-remote-owner" className="w-full" data-testid="create-project-remote-owner">
                <SelectValue placeholder="Loading…" />
              </SelectTrigger>
              <SelectContent className="homepage-theme">
                <SelectGroup>
                  {(owners ?? []).map((entry) => (
                    <SelectItem key={entry.name} value={entry.name}>{entry.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="create-project-remote-name">Repository Name</FieldLabel>
            <Input
              id="create-project-remote-name"
              autoComplete="off"
              value={name}
              disabled={disabled}
              onChange={(event) => setEditedName(event.target.value)}
              data-testid="create-project-remote-name"
            />
          </Field>
          <Field>
            <FieldLabel id="create-project-remote-visibility-label">Visibility</FieldLabel>
            <ToggleGroup
              aria-labelledby="create-project-remote-visibility-label"
              value={[visibility]}
              disabled={disabled}
              onValueChange={(values) => {
                const next = values[0] as "private" | "public" | undefined;
                if (next) setVisibility(next);
              }}
            >
              <ToggleGroupItem value="private" data-testid="create-project-remote-private">Private</ToggleGroupItem>
              <ToggleGroupItem value="public" data-testid="create-project-remote-public">Public</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </>
      ) : null}
      {reason ? (
        <p role="status" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="create-project-remote-reason">
          <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{reason}</span>
        </p>
      ) : null}
      {dialogs}
    </FieldGroup>
  );
}

/** `GitHub · ada`, or the host alone for a token without an account name. */
function hostAccountLabel(credential: { origin: string; account?: string }): string {
  const host = signInPromptFor(credential.origin).label;
  return credential.account ? `${host} · ${credential.account}` : host;
}

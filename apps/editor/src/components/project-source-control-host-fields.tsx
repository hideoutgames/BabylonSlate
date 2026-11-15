import { useEffect, useMemo, useState } from "react";
import { isOk, type SourceControlProjectSettings } from "@haptic/core";
import { credentialHasHostApi, parseRepositoryUrl, type HostCredential } from "@haptic/source-control";
import { hostApiFor, type HostRepository } from "@haptic/source-control/host-api";
import { SearchDialog, type SearchDialogItem } from "@haptic/editor-kit";
import { Alert, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldError, FieldLabel } from "@haptic/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { isTestModeEnabled } from "@haptic/vfs";
import { deviceClientId } from "../lib/source-control-client-ids";
import { useSourceControlCredentials } from "../lib/use-source-control-credentials";
import type { SourceControlAccounts } from "../services/source-control-accounts";
import { signInPromptFor } from "../services/source-control-service";
import { useHostLink } from "./use-host-link";

const TYPED_URL_ID = "typed-url";

export interface ProjectSourceControlHostFieldsProps {
  settings: SourceControlProjectSettings;
  onChange: (patch: Partial<SourceControlProjectSettings>) => void;
  urlMissing: boolean;
  onUrlTyped: () => void;
  /** The plain Repository URL and Branch fields, shown where no host API applies. */
  renderUrlField: () => React.ReactNode;
  renderBranchField: () => React.ReactNode;
  /** Integrated mode: the working copy's repository and branch, shown as they are, with no pickers. */
  fixed?: boolean;
}

function hostLabel(origin: string): string {
  return signInPromptFor(origin).label;
}

function useRepositories(accounts: SourceControlAccounts | null, credentials: HostCredential[], open: boolean) {
  const [state, setState] = useState<{ items: Array<HostRepository & { origin: string }>; error: string | null; loading: boolean }>({ items: [], error: null, loading: false });
  useEffect(() => {
    if (!open || !accounts?.http) return;
    let alive = true;
    const http = accounts.http;
    setState((current) => ({ ...current, loading: true, error: null }));
    void Promise.all(credentials.map(async (credential) => {
      const api = hostApiFor(credential, http, accounts.credentialSource(credential.origin));
      if (!api) return { items: [], error: null };
      const listed = await api.repositories();
      return isOk(listed)
        ? { items: listed.value.map((repository) => ({ ...repository, origin: credential.origin })), error: null }
        : { items: [], error: `${hostLabel(credential.origin)}: ${listed.error.message}` };
    })).then((results) => {
      if (!alive) return;
      const errors = results.flatMap((result) => (result.error ? [result.error] : []));
      setState({ items: results.flatMap((result) => result.items), error: errors.join(" ") || null, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [accounts, credentials, open]);
  return state;
}

function useBranches(accounts: SourceControlAccounts | null, credential: HostCredential | null, repositoryPath: string | null) {
  const [branches, setBranches] = useState<string[] | null>(null);
  useEffect(() => {
    setBranches(null);
    const http = accounts?.http;
    const api = credential && http && accounts ? hostApiFor(credential, http, accounts.credentialSource(credential.origin)) : null;
    if (!api || !repositoryPath) return;
    let alive = true;
    void api.branches(repositoryPath).then((listed) => {
      if (alive && isOk(listed)) setBranches(listed.value);
    });
    return () => {
      alive = false;
    };
  }, [accounts, credential, repositoryPath]);
  return branches;
}

/**
 * Project Settings → Source Control rows that know the device's accounts:
 * Repository and Branch pickers from the host API when signed in to GitHub or
 * GitLab, and the account state with Sign In. Loaded only while the mode is
 * not Off.
 */
export default function ProjectSourceControlHostFields({
  settings,
  onChange,
  urlMissing,
  onUrlTyped,
  renderUrlField,
  renderBranchField,
  fixed = false,
}: ProjectSourceControlHostFieldsProps) {
  const { accounts, credentials } = useSourceControlCredentials();
  const { link, dialogs } = useHostLink();
  const [pickerOpen, setPickerOpen] = useState(false);
  const apiCredentials = useMemo(() => credentials.filter((credential) => credentialHasHostApi(credential.kind)), [credentials]);
  const location = parseRepositoryUrl(settings.repositoryUrl);
  const credential = location ? credentials.find((candidate) => candidate.origin === location.origin) ?? null : null;
  const repositories = useRepositories(accounts, apiCredentials, pickerOpen);
  const branchCredential = !fixed && credential && credentialHasHostApi(credential.kind) ? credential : null;
  const branches = useBranches(accounts, branchCredential, location?.path ?? null);
  const prompt = location ? signInPromptFor(location.origin) : null;
  const canDeviceSignIn = prompt?.deviceHost ? deviceClientId(prompt.deviceHost, isTestModeEnabled()) !== null : false;

  const items = useMemo((): SearchDialogItem[] => [
    { id: TYPED_URL_ID, label: "Use Typed URL", description: "Any Git host", pinned: true, keepOpen: true },
    ...repositories.items.map((repository) => ({
      id: repository.repositoryUrl,
      label: repository.name,
      description: repository.private ? "Private" : "Public",
      group: hostLabel(repository.origin),
    })),
  ], [repositories.items]);

  return (
    <>
      {apiCredentials.length > 0 && !fixed ? (
        <Field className="settings-field" data-invalid={urlMissing || undefined}>
          <FieldLabel htmlFor="settings-source-control-repository">Repository</FieldLabel>
          <Button
            id="settings-source-control-repository"
            type="button"
            variant="outline"
            className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start truncate"
            data-testid="settings-source-control-repository"
            aria-invalid={urlMissing || undefined}
            onClick={() => setPickerOpen(true)}
          >
            {location ? location.path : settings.repositoryUrl || "Choose Repository"}
          </Button>
          {urlMissing ? (
            <FieldError data-testid="settings-source-control-url-error">
              Choose a repository before turning on Source Control.
            </FieldError>
          ) : null}
        </Field>
      ) : (
        renderUrlField()
      )}
      {branchCredential && branches ? (
        <Field className="settings-field">
          <FieldLabel htmlFor="settings-source-control-branch">Branch</FieldLabel>
          <Select value={settings.branch} onValueChange={(value) => { if (value) onChange({ branch: String(value) }); }}>
            <SelectTrigger id="settings-source-control-branch" className="min-h-[var(--chrome-row,28px)] w-full" data-testid="settings-source-control-branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {[...new Set([settings.branch, ...branches])].map((branch) => (
                  <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : (
        renderBranchField()
      )}
      {prompt ? (
        <Field orientation="horizontal" className="settings-field" data-testid="settings-source-control-account">
          <FieldLabel>Account</FieldLabel>
          <div id="settings-source-control-account" className="flex min-w-0 items-center justify-end gap-2">
            <span className="min-w-0 truncate text-xs text-muted-foreground" data-testid="settings-source-control-account-state">
              {credential
                ? credential.account ? `${credential.account} (${prompt.label})` : `Token Saved (${prompt.label})`
                : "Not Signed In"}
            </span>
            {!credential && canDeviceSignIn && prompt.deviceHost ? (
              <Button
                size="sm"
                data-testid="settings-source-control-sign-in"
                onClick={() => void link({ kind: "sign-in", host: prompt.deviceHost! })}
              >
                Sign In
              </Button>
            ) : null}
          </div>
        </Field>
      ) : null}
      <SearchDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title="Pick Repository"
        placeholder="Search or type a URL"
        items={items}
        busy={repositories.loading}
        emptyLabel={repositories.loading ? "Loading Repositories…" : "No Repositories"}
        status={repositories.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could Not List Repositories</AlertTitle>
            <AlertDescription>{repositories.error}</AlertDescription>
          </Alert>
        ) : null}
        onSelect={(id, query) => {
          if (id === TYPED_URL_ID) {
            if (!parseRepositoryUrl(query)) return;
            onUrlTyped();
            onChange({ repositoryUrl: query.trim() });
            setPickerOpen(false);
            return;
          }
          const repository = repositories.items.find((entry) => entry.repositoryUrl === id);
          if (!repository) return;
          onUrlTyped();
          onChange({ repositoryUrl: repository.repositoryUrl, branch: repository.defaultBranch });
          setPickerOpen(false);
        }}
        data-testid="settings-source-control-repository-picker"
      />
      {dialogs}
    </>
  );
}

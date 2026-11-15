import { useEffect, useMemo, useState } from "react";
import { Github as GithubIcon, Gitlab as GitlabIcon, LinkIcon } from "lucide-react";
import { isOk } from "@haptic/core";
import {
  GITHUB_ORIGIN,
  GITLAB_ORIGIN,
  type HostCredential,
} from "@haptic/source-control";
import { hostApiFor, type HostApi, type HostOwner } from "@haptic/source-control/host-api";
import type { SourceControlAccounts } from "../services/source-control-accounts";
import { useSourceControlCredentials } from "./use-source-control-credentials";

/** The hosts whose REST API Clone and Publish use; any other host is a typed URL. */
export type ApiHost = "github" | "gitlab";

export const API_HOSTS: Record<ApiHost, { label: string; origin: string; icon: typeof GithubIcon }> = {
  github: { label: "GitHub", origin: GITHUB_ORIGIN, icon: GithubIcon },
  gitlab: { label: "GitLab", origin: GITLAB_ORIGIN, icon: GitlabIcon },
};

export const URL_HOST_ICON = LinkIcon;

export interface HostAccount {
  accounts: SourceControlAccounts | null;
  credential: HostCredential | null;
  /** The host's REST API for the credential (GitHub and GitLab only). */
  api: HostApi | null;
}

/** This device's credential for `origin`, kept current as accounts are linked, and its host API. */
export function useHostAccount(origin: string | null): HostAccount {
  const { accounts, credentials } = useSourceControlCredentials();
  return useAccountApi(accounts, origin ? credentials.find((candidate) => candidate.origin === origin) ?? null : null);
}

/** The host API for one of this device's credentials, kept while the credential is the same. */
export function useAccountApi(accounts: SourceControlAccounts | null, credential: HostCredential | null): HostAccount {
  const api = useMemo(
    () => (credential && accounts?.http ? hostApiFor(credential, accounts.http, accounts.credentialSource(credential.origin)) : null),
    [accounts, credential],
  );
  return { accounts, credential, api };
}

/**
 * Where Publish can create a repository with `api` (`HostApi.owners`: the
 * signed-in user first, then organizations or groups); null while loading or
 * without an API, with the error when the user cannot be read.
 */
export function useHostOwners(api: HostApi | null): { owners: HostOwner[] | null; error: string | null } {
  const [loaded, setLoaded] = useState<{ api: HostApi; owners: HostOwner[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.owners().then((result) => {
      if (alive) setLoaded(isOk(result) ? { api, owners: result.value, error: null } : { api, owners: null, error: result.error.message });
    });
    return () => {
      alive = false;
    };
  }, [api]);
  // A reply for another account's API is never shown.
  return loaded && loaded.api === api ? { owners: loaded.owners, error: loaded.error } : { owners: null, error: null };
}

/** A repository name from a project name: `Forest Run` → `forest-run`. */
export function repositoryNameFor(projectName: string): string {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

/** A project name from a repository path: `team/forest-run` → `Forest Run`. */
export function projectNameFor(repositoryPath: string): string {
  const name = repositoryPath.replace(/\.git$/, "").split("/").pop() ?? "";
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

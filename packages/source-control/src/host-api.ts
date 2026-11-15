import { err, isOk, ok, type Result } from "@haptic/core";
import {
  authorizedHttp,
  credentialHasHostApi,
  fixedCredential,
  GITHUB_API_ORIGIN,
  GITHUB_ORIGIN,
  type CredentialSource,
  type HostCredential,
} from "./credentials";
import { errorMessage, parseJsonArray, parseJsonObject, stringField, type HttpClient } from "./http";
import { repositoryCloneUrl } from "./lfs-endpoint";

export interface HostApiError {
  kind: "unauthorized" | "offline" | "http";
  message: string;
}

export type HostApiResult<T> = Result<T, HostApiError>;

export interface HostRepository {
  /** `owner/name`, or the GitLab path with its groups. */
  name: string;
  /** HTTPS clone URL. */
  repositoryUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
}

/**
 * The host REST API calls Haptic makes for convenience (never for sync):
 * repository and branch pickers and Release Pushed Locks.
 */
export interface HostApi {
  repositories(): Promise<HostApiResult<HostRepository[]>>;
  branches(repositoryPath: string): Promise<HostApiResult<string[]>>;
  /**
   * Git blob ids on the remote branch for the wanted paths. A path missing
   * from the result is not on the branch (or the listing was cut short), so it
   * never counts as pushed. Reads only as many pages as finding them needs.
   */
  blobIds(repositoryPath: string, branch: string, paths: ReadonlySet<string>): Promise<HostApiResult<Map<string, string>>>;
}

const PAGE_SIZE = 100;
/** Pickers list at most this many pages; a larger account searches on the host. */
const MAX_LIST_PAGES = 10;
/** A recursive GitLab tree page holds 100 entries; stop well past any project size. */
const MAX_TREE_PAGES = 2_000;

type Json = Record<string, unknown>;

function client(source: CredentialSource, http: HttpClient, accept: string) {
  const request = authorizedHttp(source, http, "bearer");
  return async (url: string): Promise<HostApiResult<unknown>> => {
    let response;
    try {
      response = await request({ method: "GET", url, headers: { Accept: accept } });
    } catch (error) {
      return err({ kind: "offline", message: errorMessage(error) });
    }
    if (response.status === 200) {
      const body = parseJsonObject(response.bodyText) ?? parseJsonArray(response.bodyText);
      return body ? ok(body) : err({ kind: "http", message: "Invalid host response" });
    }
    const message = stringField(parseJsonObject(response.bodyText), "message") ?? `HTTP ${response.status}`;
    return err({ kind: response.status === 401 || response.status === 403 ? "unauthorized" : "http", message });
  };
}

/** Reads `page=1..` until a short page, `done` says enough, or the page cap. */
async function paged<T>(
  get: (url: string) => Promise<HostApiResult<unknown>>,
  url: (page: number) => string,
  read: (entry: Json) => T | null,
  maxPages: number,
  done: (items: T[]) => boolean = () => false,
): Promise<HostApiResult<T[]>> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await get(url(page));
    if (!isOk(response)) return response;
    if (!Array.isArray(response.value)) return err({ kind: "http", message: "Invalid host response" });
    for (const entry of response.value) {
      const item = entry && typeof entry === "object" ? read(entry as Json) : null;
      if (item !== null) items.push(item);
    }
    if (response.value.length < PAGE_SIZE || done(items)) break;
  }
  return ok(items);
}

function str(json: Json, key: string): string {
  const value = json[key];
  return typeof value === "string" ? value : "";
}

function blobEntry(json: Json, idKey: string): [string, string] | null {
  const path = str(json, "path");
  const id = str(json, idKey);
  return json.type === "blob" && path && id ? [path, id] : null;
}

function gitHubApi(source: CredentialSource, http: HttpClient): HostApi {
  const get = client(source, http, "application/vnd.github+json");
  const repo = (path: string) => `${GITHUB_API_ORIGIN}/repos/${path.split("/").map(encodeURIComponent).join("/")}`;
  return {
    repositories: () => paged(get, (page) => `${GITHUB_API_ORIGIN}/user/repos?per_page=${PAGE_SIZE}&sort=updated&page=${page}`, (entry) => {
      const name = str(entry, "full_name");
      return name ? {
        name,
        repositoryUrl: repositoryCloneUrl({ origin: GITHUB_ORIGIN, path: name }),
        defaultBranch: str(entry, "default_branch") || "main",
        private: entry.private === true,
        updatedAt: str(entry, "pushed_at") || str(entry, "updated_at"),
      } : null;
    }, MAX_LIST_PAGES),
    branches: (path) => paged(get, (page) => `${repo(path)}/branches?per_page=${PAGE_SIZE}&page=${page}`, (entry) => str(entry, "name") || null, MAX_LIST_PAGES),
    // One request: GitHub returns the whole recursive tree (marked truncated past its limit).
    async blobIds(path, branch, paths) {
      const response = await get(`${repo(path)}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (!isOk(response)) return response;
      const tree = (response.value as Json).tree;
      if (!Array.isArray(tree)) return err({ kind: "http", message: "Invalid host response" });
      const found = new Map<string, string>();
      for (const entry of tree) {
        const blob = entry && typeof entry === "object" ? blobEntry(entry as Json, "sha") : null;
        if (blob && paths.has(blob[0])) found.set(blob[0], blob[1]);
      }
      return ok(found);
    },
  };
}

/** gitlab.com and self-managed instances alike: the API is under the instance origin. */
function gitLabApi(credential: HostCredential, source: CredentialSource, http: HttpClient): HostApi {
  const get = client(source, http, "application/json");
  const base = `${credential.origin}/api/v4`;
  const project = (path: string) => `${base}/projects/${encodeURIComponent(path)}`;
  return {
    repositories: () => paged(get, (page) => `${base}/projects?membership=true&order_by=last_activity_at&per_page=${PAGE_SIZE}&page=${page}`, (entry) => {
      const name = str(entry, "path_with_namespace");
      return name ? {
        name,
        repositoryUrl: repositoryCloneUrl({ origin: credential.origin, path: name }),
        defaultBranch: str(entry, "default_branch") || "main",
        private: entry.visibility !== "public",
        updatedAt: str(entry, "last_activity_at"),
      } : null;
    }, MAX_LIST_PAGES),
    branches: (path) => paged(get, (page) => `${project(path)}/repository/branches?per_page=${PAGE_SIZE}&page=${page}`, (entry) => str(entry, "name") || null, MAX_LIST_PAGES),
    async blobIds(path, branch, paths) {
      const ref = encodeURIComponent(branch);
      const listed = await paged(
        get,
        (page) => `${project(path)}/repository/tree?ref=${ref}&recursive=true&per_page=${PAGE_SIZE}&page=${page}`,
        (entry) => {
          const blob = blobEntry(entry, "id");
          return blob && paths.has(blob[0]) ? blob : null;
        },
        MAX_TREE_PAGES,
        (found) => found.length >= paths.size,
      );
      return isOk(listed) ? ok(new Map(listed.value)) : listed;
    },
  };
}

/**
 * The REST API for a credential's host, or null for hosts Haptic has no API
 * code for. Requests take their credential from `source` (renewed after a 401).
 */
export function hostApiFor(
  credential: HostCredential,
  http: HttpClient,
  source: CredentialSource = fixedCredential(credential),
): HostApi | null {
  if (!credentialHasHostApi(credential.kind)) return null;
  return credential.kind === "github" ? gitHubApi(source, http) : gitLabApi(credential, source, http);
}

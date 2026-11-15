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
  /** `not-found`: a 404, such as a folder that is not on the branch. */
  kind: "unauthorized" | "offline" | "not-found" | "http";
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

/** Where Publish can create a repository: the signed-in user, or an organization (GitLab: group) they belong to. */
export interface HostOwner {
  /** The login, or the GitLab group's full path. */
  name: string;
  kind: "user" | "organization";
  /** GitLab's namespace id for a group; empty for the user and on GitHub. */
  id: string;
}

export interface CreateRepositoryInput {
  owner: HostOwner;
  name: string;
  private: boolean;
}

/**
 * The host REST API calls Haptic makes for convenience (never for sync):
 * repository and branch pickers, Publish and Release Pushed Locks.
 */
export interface HostApi {
  repositories(): Promise<HostApiResult<HostRepository[]>>;
  /**
   * The signed-in user first, then their organizations (GitLab: groups they
   * may create projects in). Only reading the user can fail: when the host
   * refuses the organization listing (GitHub does for an OAuth token without
   * `read:org` or `user`), the user is the only owner.
   */
  owners(): Promise<HostApiResult<HostOwner[]>>;
  /** Creates an empty repository (no README, so the first push sets its branch). */
  createRepository(input: CreateRepositoryInput): Promise<HostApiResult<HostRepository>>;
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
/** A GitLab folder listing page holds 100 entries; stop well past any folder size. */
const MAX_TREE_PAGES = 200;

type Json = Record<string, unknown>;

/** A host's error text: GitHub's `message` with its first field error, GitLab's `message` (text, or field errors) or `error`. */
function hostErrorMessage(body: Json | null, status: number): string {
  const message = body?.message;
  if (typeof message === "string" && message) {
    const first = Array.isArray(body?.errors) ? (body.errors[0] as Json | undefined) : undefined;
    const detail = first && typeof first.message === "string" ? first.message : null;
    return detail ? `${message} ${detail}` : message;
  }
  if (message && typeof message === "object") {
    const fields = Object.entries(message as Json).map(([field, problems]) =>
      `${field} ${Array.isArray(problems) ? problems.join(", ") : String(problems)}`);
    if (fields.length > 0) return fields.join("; ");
  }
  return stringField(body, "error") ?? `HTTP ${status}`;
}

function client(source: CredentialSource, http: HttpClient, accept: string) {
  const request = authorizedHttp(source, http, "bearer");
  return async (url: string, post?: Json): Promise<HostApiResult<unknown>> => {
    let response;
    try {
      response = await request(post
        ? { method: "POST", url, headers: { Accept: accept, "Content-Type": "application/json" }, body: JSON.stringify(post) }
        : { method: "GET", url, headers: { Accept: accept } });
    } catch (error) {
      return err({ kind: "offline", message: errorMessage(error) });
    }
    if (response.status === 200 || response.status === 201) {
      const body = parseJsonObject(response.bodyText) ?? parseJsonArray(response.bodyText);
      return body ? ok(body) : err({ kind: "http", message: "Invalid host response" });
    }
    const message = hostErrorMessage(parseJsonObject(response.bodyText), response.status);
    const kind = response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 404 ? "not-found" : "http";
    return err({ kind, message });
  };
}

/** A JSON object answer, or an error for anything else. */
function objectOf(result: HostApiResult<unknown>): HostApiResult<Json> {
  if (!isOk(result)) return result;
  return result.value && typeof result.value === "object" && !Array.isArray(result.value)
    ? ok(result.value as Json)
    : err({ kind: "http", message: "Invalid host response" });
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

/** Wanted paths grouped by their folder (`""` for the repository root). */
function pathsByFolder(paths: ReadonlySet<string>): Map<string, Set<string>> {
  const folders = new Map<string, Set<string>>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const folder = slash < 0 ? "" : path.slice(0, slash);
    const wanted = folders.get(folder) ?? new Set<string>();
    wanted.add(path);
    folders.set(folder, wanted);
  }
  return folders;
}

function blobEntry(json: Json, idKey: string): [string, string] | null {
  const path = str(json, "path");
  const id = str(json, idKey);
  return json.type === "blob" && path && id ? [path, id] : null;
}

function gitHubRepository(entry: Json): HostRepository | null {
  const name = str(entry, "full_name");
  return name ? {
    name,
    repositoryUrl: repositoryCloneUrl({ origin: GITHUB_ORIGIN, path: name }),
    defaultBranch: str(entry, "default_branch") || "main",
    private: entry.private === true,
    updatedAt: str(entry, "pushed_at") || str(entry, "updated_at"),
  } : null;
}

function gitHubApi(source: CredentialSource, http: HttpClient): HostApi {
  const get = client(source, http, "application/vnd.github+json");
  const repo = (path: string) => `${GITHUB_API_ORIGIN}/repos/${path.split("/").map(encodeURIComponent).join("/")}`;
  return {
    repositories: () => paged(get, (page) => `${GITHUB_API_ORIGIN}/user/repos?per_page=${PAGE_SIZE}&sort=updated&page=${page}`, gitHubRepository, MAX_LIST_PAGES),
    async owners() {
      const user = objectOf(await get(`${GITHUB_API_ORIGIN}/user`));
      if (!isOk(user)) return user;
      const login = str(user.value, "login");
      if (!login) return err({ kind: "http", message: "Invalid host response" });
      const organizations = await paged(get, (page) => `${GITHUB_API_ORIGIN}/user/orgs?per_page=${PAGE_SIZE}&page=${page}`, (entry) => {
        const name = str(entry, "login");
        return name ? { name, kind: "organization" as const, id: "" } : null;
      }, MAX_LIST_PAGES);
      return ok([{ name: login, kind: "user", id: "" }, ...(isOk(organizations) ? organizations.value : [])]);
    },
    async createRepository({ owner, name, private: isPrivate }) {
      const url = owner.kind === "user"
        ? `${GITHUB_API_ORIGIN}/user/repos`
        : `${GITHUB_API_ORIGIN}/orgs/${encodeURIComponent(owner.name)}/repos`;
      const created = objectOf(await get(url, { name, private: isPrivate, auto_init: false }));
      if (!isOk(created)) return created;
      const repository = gitHubRepository(created.value);
      return repository ? ok(repository) : err({ kind: "http", message: "Invalid host response" });
    },
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
/** GitLab's Developer role, the least that may create projects in a group. */
const GITLAB_DEVELOPER_ACCESS = 30;

function gitLabApi(credential: HostCredential, source: CredentialSource, http: HttpClient): HostApi {
  const get = client(source, http, "application/json");
  const base = `${credential.origin}/api/v4`;
  const project = (path: string) => `${base}/projects/${encodeURIComponent(path)}`;
  const repository = (entry: Json): HostRepository | null => {
    const name = str(entry, "path_with_namespace");
    return name ? {
      name,
      repositoryUrl: repositoryCloneUrl({ origin: credential.origin, path: name }),
      defaultBranch: str(entry, "default_branch") || "main",
      private: entry.visibility !== "public",
      updatedAt: str(entry, "last_activity_at"),
    } : null;
  };
  return {
    repositories: () => paged(get, (page) => `${base}/projects?membership=true&order_by=last_activity_at&per_page=${PAGE_SIZE}&page=${page}`, repository, MAX_LIST_PAGES),
    async owners() {
      const user = objectOf(await get(`${base}/user`));
      if (!isOk(user)) return user;
      const username = str(user.value, "username");
      if (!username) return err({ kind: "http", message: "Invalid host response" });
      const groups = await paged(get, (page) => `${base}/groups?min_access_level=${GITLAB_DEVELOPER_ACCESS}&per_page=${PAGE_SIZE}&page=${page}`, (entry) => {
        const name = str(entry, "full_path");
        const id = typeof entry.id === "number" || typeof entry.id === "string" ? String(entry.id) : "";
        return name && id ? { name, kind: "organization" as const, id } : null;
      }, MAX_LIST_PAGES);
      return ok([{ name: username, kind: "user", id: "" }, ...(isOk(groups) ? groups.value : [])]);
    },
    async createRepository({ owner, name, private: isPrivate }) {
      const created = objectOf(await get(`${base}/projects`, {
        name,
        path: name,
        visibility: isPrivate ? "private" : "public",
        ...(owner.kind === "organization" ? { namespace_id: owner.id } : {}),
      }));
      if (!isOk(created)) return created;
      const result = repository(created.value);
      return result ? ok(result) : err({ kind: "http", message: "Invalid host response" });
    },
    branches: (path) => paged(get, (page) => `${project(path)}/repository/branches?per_page=${PAGE_SIZE}&page=${page}`, (entry) => str(entry, "name") || null, MAX_LIST_PAGES),
    // GitLab has no single-request recursive tree, so list only the folders
    // that hold wanted paths, each until its wanted paths are found.
    async blobIds(path, branch, paths) {
      const ref = encodeURIComponent(branch);
      const found = new Map<string, string>();
      for (const [folder, wanted] of pathsByFolder(paths)) {
        const at = folder ? `&path=${encodeURIComponent(folder)}` : "";
        const listed = await paged(
          get,
          (page) => `${project(path)}/repository/tree?ref=${ref}${at}&per_page=${PAGE_SIZE}&page=${page}`,
          (entry) => {
            const blob = blobEntry(entry, "id");
            return blob && wanted.has(blob[0]) ? blob : null;
          },
          MAX_TREE_PAGES,
          (items) => items.length >= wanted.size,
        );
        // A folder missing from the branch holds nothing pushed.
        if (!isOk(listed)) {
          if (listed.error.kind === "not-found") continue;
          return listed;
        }
        for (const [blobPath, id] of listed.value) found.set(blobPath, id);
      }
      return ok(found);
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

import { err, isOk, ok } from "@haptic/core";
import { authorizedHttp, credentialAllowsOrigin, type CredentialKind } from "./credentials";
import { errorMessage, originOf, parseJsonObject, type HttpRequest, type HttpResponse } from "./http";
import {
  lfsEndpointFromRepoUrl,
  lfsLocksUrl,
  lfsRefName,
} from "./lfs-endpoint";
import type {
  FileLock,
  GitLfsLockProviderOptions,
  LockProvider,
  LockResult,
  UnlockOptions,
  VerifyOptions,
} from "./types";
import { LFS_JSON } from "./types";

/** A host without the Git LFS locking API answers its lock endpoints with one of these. */
const NO_LOCKING_STATUSES = new Set([404, 501]);

/** GitHub and GitLab always have the locking API, so there a 404 means the token cannot see the repository. */
const HOSTS_WITH_LOCKING = new Set<CredentialKind>(["github", "gitlab", "gitlab-token"]);

interface RawLock {
  id?: unknown;
  path?: unknown;
  locked_at?: unknown;
  owner?: { name?: unknown } | null;
}

export class GitLfsLockProvider implements LockProvider {
  private readonly locksUrl: string;
  private readonly origin: string;
  private readonly branch: () => string;
  private readonly http: GitLfsLockProviderOptions["http"];
  private readonly credential: GitLfsLockProviderOptions["credential"];

  constructor(options: GitLfsLockProviderOptions) {
    const base = lfsEndpointFromRepoUrl(options.repositoryUrl);
    if (!base) {
      throw new Error(`Invalid source-control repository URL: ${options.repositoryUrl}`);
    }
    this.locksUrl = lfsLocksUrl(base);
    this.origin = originOf(base)!;
    this.branch = options.branch;
    this.http = options.http;
    this.credential = options.credential;
  }

  async create(path: string): Promise<LockResult<FileLock>> {
    const response = await this.request({
      method: "POST",
      url: this.locksUrl,
      body: { path, ref: refOf(this.branch()) },
    });
    if (!isOk(response)) return response;
    const { status, json, kind } = response.value;
    if (status === 409) {
      const ours = await this.oursLockForPath(path);
      if (ours) return ok(ours);
      const lock = parseLock(json?.lock, false);
      return err({
        kind: "conflict",
        message: messageOf(json, "already created lock"),
        lock: lock ?? undefined,
        status,
      });
    }
    if (status === 201 || status === 200) {
      const lock = parseLock(json?.lock, true);
      if (!lock) {
        return err({ kind: "http", message: "create response missing lock", status });
      }
      return ok(lock);
    }
    return this.lockingError(status, json, kind);
  }

  async verify(options: VerifyOptions = {}): Promise<LockResult<{ ours: FileLock[]; theirs: FileLock[] }>> {
    const ours: FileLock[] = [];
    const theirs: FileLock[] = [];
    const cursors = new Set<string>();
    // Every page of one listing names the same branch.
    const ref = refOf(options.branch ?? this.branch());
    let cursor: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = { ref };
      if (cursor) body.cursor = cursor;
      const response = await this.request({
        method: "POST",
        url: `${this.locksUrl}/verify`,
        body,
      });
      if (!isOk(response)) return response;
      const { status, json, kind } = response.value;
      if (status !== 200) return this.lockingError(status, json, kind);
      // An unreadable 200 must not read as "no locks": a refresh would clear them.
      if (!json || !appendLocks(ours, json.ours, true) || !appendLocks(theirs, json.theirs, false)) {
        return err({ kind: "http", message: "Invalid lock verify response", status });
      }
      const next =
        typeof json.next_cursor === "string" && json.next_cursor !== ""
          ? json.next_cursor
          : undefined;
      if (!next) break;
      if (cursors.has(next)) {
        return err({ kind: "http", message: "Lock verify pagination repeated a cursor", status });
      }
      cursors.add(next);
      cursor = next;
    }
    return ok({ ours, theirs });
  }

  async unlock(id: string, options?: UnlockOptions): Promise<LockResult<void>> {
    const response = await this.request({
      method: "POST",
      url: `${this.locksUrl}/${encodeURIComponent(id)}/unlock`,
      body: { force: options?.force === true, ref: refOf(this.branch()) },
    });
    if (!isOk(response)) return response;
    const { status, json } = response.value;
    if (status === 200 || status === 201) return ok(undefined);
    return this.httpError(status, json);
  }

  private async oursLockForPath(path: string): Promise<FileLock | null> {
    const verified = await this.verify();
    if (!isOk(verified)) return null;
    return verified.value.ours.find((lock) => lock.path === path) ?? null;
  }

  private async request(input: {
    method: "POST";
    url: string;
    body?: unknown;
  }): Promise<LockResult<{ status: number; json: Record<string, unknown> | null; kind: CredentialKind }>> {
    let credential;
    try {
      credential = await this.credential.current();
    } catch (error) {
      return err({ kind: "offline", message: errorMessage(error) });
    }
    if (!credential || !credentialAllowsOrigin(credential, this.origin)) {
      return err({
        kind: "unauthorized",
        message: `Sign in to ${new URL(this.origin).host} to use file locking.`,
      });
    }
    const headers: Record<string, string> = { Accept: LFS_JSON };
    const request: HttpRequest = {
      method: input.method,
      url: input.url,
      headers,
    };
    if (input.body !== undefined) {
      headers["Content-Type"] = LFS_JSON;
      request.body = JSON.stringify(input.body);
    }
    let response: HttpResponse;
    try {
      // A 401 renews the credential (a GitLab sign-in refreshes) and retries once.
      response = await authorizedHttp(this.credential, this.http, "basic")(request);
    } catch (error) {
      return err({ kind: "offline", message: errorMessage(error) });
    }
    const json = parseJsonObject(response.bodyText);
    if (response.status === 401 || response.status === 403) {
      return err({
        kind: "unauthorized",
        message: messageOf(json, "unauthorized"),
        status: response.status,
      });
    }
    return ok({ status: response.status, json, kind: credential.kind });
  }

  /** Create and verify only: an unlock's 404 means the lock is already gone. */
  private lockingError(
    status: number,
    json: Record<string, unknown> | null,
    kind: CredentialKind,
  ): LockResult<never> {
    if (NO_LOCKING_STATUSES.has(status) && HOSTS_WITH_LOCKING.has(kind)) {
      return err({ kind: "http", message: "Repository Not Found Or No Access", status });
    }
    if (NO_LOCKING_STATUSES.has(status)) {
      return err({ kind: "unsupported", message: "This Host Does Not Support File Locking.", status });
    }
    return this.httpError(status, json);
  }

  private httpError(
    status: number,
    json: Record<string, unknown> | null,
  ): LockResult<never> {
    return err({
      kind: "http",
      message: messageOf(json, `HTTP ${status}`),
      status,
    });
  }
}

/** The Git LFS locking API's `ref`: the branch the locks belong to. */
function refOf(branch: string): { name: string } {
  return { name: lfsRefName(branch) };
}

function messageOf(json: Record<string, unknown> | null, fallback: string): string {
  return typeof json?.message === "string" && json.message !== ""
    ? json.message
    : fallback;
}

/** False when the list is present but not an array; servers may omit or null an empty list. */
function appendLocks(
  target: FileLock[],
  raw: unknown,
  ours: boolean,
): boolean {
  if (raw === undefined || raw === null) return true;
  if (!Array.isArray(raw)) return false;
  for (const entry of raw) {
    const lock = parseLock(entry, ours);
    if (lock) target.push(lock);
  }
  return true;
}

function parseLock(raw: unknown, ours: boolean): FileLock | null {
  if (!raw || typeof raw !== "object") return null;
  const lock = raw as RawLock;
  if (typeof lock.id !== "string" || lock.id === "") return null;
  if (typeof lock.path !== "string" || lock.path === "") return null;
  const ownerName =
    lock.owner && typeof lock.owner.name === "string" ? lock.owner.name : "";
  return {
    id: lock.id,
    path: lock.path,
    ownerName,
    // Unknown stays empty (shown as an unknown age), never a 1970 timestamp.
    lockedAt: typeof lock.locked_at === "string" ? lock.locked_at : "",
    ours,
  };
}

import { err, isOk, ok } from "@haptic/core";
import {
  lfsEndpointFromRepoUrl,
  lfsLocksUrl,
  lfsRefName,
} from "./lfs-endpoint";
import type {
  FileLock,
  GitLfsLockProviderOptions,
  LfsRequest,
  LfsResponse,
  LockProvider,
  LockResult,
  UnlockOptions,
} from "./types";
import { LFS_JSON } from "./types";

interface RawLock {
  id?: unknown;
  path?: unknown;
  locked_at?: unknown;
  owner?: { name?: unknown } | null;
}

export class GitLfsLockProvider implements LockProvider {
  private readonly locksUrl: string;
  private readonly ref: { name: string };
  private readonly fetchFn: GitLfsLockProviderOptions["fetch"];
  private readonly getToken: GitLfsLockProviderOptions["getToken"];

  constructor(options: GitLfsLockProviderOptions) {
    const base = lfsEndpointFromRepoUrl(options.repositoryUrl);
    if (!base) {
      throw new Error(`Invalid source-control repository URL: ${options.repositoryUrl}`);
    }
    this.locksUrl = lfsLocksUrl(base);
    this.ref = { name: lfsRefName(options.branch || "main") };
    this.fetchFn = options.fetch;
    this.getToken = options.getToken;
  }

  async create(path: string): Promise<LockResult<FileLock>> {
    const response = await this.request({
      method: "POST",
      url: this.locksUrl,
      body: { path, ref: this.ref },
    });
    if (!isOk(response)) return response;
    const { status, json } = response.value;
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
    return this.httpError(status, json);
  }

  async verify(): Promise<LockResult<{ ours: FileLock[]; theirs: FileLock[] }>> {
    const ours: FileLock[] = [];
    const theirs: FileLock[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = { ref: this.ref };
      if (cursor) body.cursor = cursor;
      const response = await this.request({
        method: "POST",
        url: `${this.locksUrl}/verify`,
        body,
      });
      if (!isOk(response)) return response;
      const { status, json } = response.value;
      if (status !== 200) return this.httpError(status, json);
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
      body: { force: options?.force === true, ref: this.ref },
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
  }): Promise<LockResult<{ status: number; json: Record<string, unknown> | null }>> {
    const token = await this.getToken();
    if (!token) {
      return err({
        kind: "unauthorized",
        message: "No source-control token stored",
      });
    }
    const headers: Record<string, string> = {
      Accept: LFS_JSON,
      Authorization: basicAuth(token),
    };
    const request: LfsRequest = {
      method: input.method,
      url: input.url,
      headers,
    };
    if (input.body !== undefined) {
      headers["Content-Type"] = LFS_JSON;
      request.body = JSON.stringify(input.body);
    }
    let response: LfsResponse;
    try {
      response = await this.fetchFn(request);
    } catch (error) {
      return err({
        kind: "offline",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const json = parseJson(response.bodyText);
    if (response.status === 401 || response.status === 403) {
      return err({
        kind: "unauthorized",
        message: messageOf(json, "unauthorized"),
        status: response.status,
      });
    }
    return ok({ status: response.status, json });
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

function basicAuth(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

/** The response object, or null when the body is empty, invalid JSON, or not an object. */
function parseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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

import { err, isOk, ok } from "@babylonslate/core";
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
      const lock = parseLock(json.lock, false);
      return err({
        kind: "conflict",
        message: messageOf(json, "already created lock"),
        lock: lock ?? undefined,
        status,
      });
    }
    if (status === 201 || status === 200) {
      const lock = parseLock(json.lock, true);
      if (!lock) {
        return err({ kind: "http", message: "create response missing lock", status });
      }
      return ok(lock);
    }
    return this.httpError(status, json);
  }

  async list(): Promise<LockResult<FileLock[]>> {
    const locks: FileLock[] = [];
    let cursor: string | undefined;
    for (;;) {
      const url = this.listUrl(cursor);
      const response = await this.request({ method: "GET", url });
      if (!isOk(response)) return response;
      const { status, json } = response.value;
      if (status !== 200) return this.httpError(status, json);
      const page = Array.isArray(json.locks) ? json.locks : [];
      for (const raw of page) {
        const lock = parseLock(raw, false);
        if (lock) locks.push(lock);
      }
      const next =
        typeof json.next_cursor === "string" && json.next_cursor !== ""
          ? json.next_cursor
          : undefined;
      if (!next) break;
      cursor = next;
    }
    return ok(locks);
  }

  async verify(): Promise<LockResult<{ ours: FileLock[]; theirs: FileLock[] }>> {
    const ours: FileLock[] = [];
    const theirs: FileLock[] = [];
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
      appendLocks(ours, json.ours, true);
      appendLocks(theirs, json.theirs, false);
      const next =
        typeof json.next_cursor === "string" && json.next_cursor !== ""
          ? json.next_cursor
          : undefined;
      if (!next) break;
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

  private listUrl(cursor?: string): string {
    const params = new URLSearchParams();
    params.set("refspec", this.ref.name);
    if (cursor) params.set("cursor", cursor);
    return `${this.locksUrl}?${params.toString()}`;
  }

  private async request(input: {
    method: "GET" | "POST";
    url: string;
    body?: unknown;
  }): Promise<LockResult<{ status: number; json: Record<string, unknown> }>> {
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
    json: Record<string, unknown>,
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

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function messageOf(json: Record<string, unknown>, fallback: string): string {
  return typeof json.message === "string" && json.message !== ""
    ? json.message
    : fallback;
}

function appendLocks(
  target: FileLock[],
  raw: unknown,
  ours: boolean,
): void {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    const lock = parseLock(entry, ours);
    if (lock) target.push(lock);
  }
}

function parseLock(raw: unknown, ours: boolean): FileLock | null {
  if (!raw || typeof raw !== "object") return null;
  const lock = raw as RawLock;
  if (typeof lock.id !== "string" || lock.id === "") return null;
  if (typeof lock.path !== "string" || lock.path === "") return null;
  const ownerName =
    lock.owner && typeof lock.owner.name === "string" ? lock.owner.name : "";
  const lockedAt =
    typeof lock.locked_at === "string" && lock.locked_at !== ""
      ? lock.locked_at
      : new Date(0).toISOString();
  return {
    id: lock.id,
    path: lock.path,
    ownerName,
    lockedAt,
    ours,
  };
}

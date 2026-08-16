import type { Result } from "@babylonslate/core";

export const LFS_JSON = "application/vnd.git-lfs+json";
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_SOURCE_CONTROL_BRANCH = "main";

export interface FileLock {
  id: string;
  path: string;
  ownerName: string;
  lockedAt: string;
  ours: boolean;
}

export type LockErrorKind = "conflict" | "offline" | "unauthorized" | "http";

export interface LockError {
  kind: LockErrorKind;
  message: string;
  lock?: FileLock;
  status?: number;
}

export type LockResult<T> = Result<T, LockError>;

export interface UnlockOptions {
  force?: boolean;
}

export interface LockProvider {
  create(path: string): Promise<LockResult<FileLock>>;
  list(): Promise<LockResult<FileLock[]>>;
  verify(): Promise<LockResult<{ ours: FileLock[]; theirs: FileLock[] }>>;
  unlock(id: string, options?: UnlockOptions): Promise<LockResult<void>>;
}

export interface LfsRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface LfsResponse {
  status: number;
  bodyText: string;
}

export type LfsFetch = (request: LfsRequest) => Promise<LfsResponse>;

export type TokenGetter = () => Promise<string | null>;

export interface GitLfsLockProviderOptions {
  repositoryUrl: string;
  branch: string;
  fetch: LfsFetch;
  getToken: TokenGetter;
}

export interface GitConfigPrefill {
  repositoryUrl: string;
  branch: string;
}

export const SOURCE_CONTROL_SECRET_PREFIX = "source-control:";

export function sourceControlSecretKey(projectGuid: string): string {
  return `${SOURCE_CONTROL_SECRET_PREFIX}${projectGuid}`;
}

export function isSourceControlHost(
  platform: string,
  testMode: boolean,
): boolean {
  if (testMode) return true;
  return platform === "ios" || platform === "android" || platform === "electron";
}

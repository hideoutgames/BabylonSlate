import type { Result } from "@haptic/core";
import type { CredentialSource } from "./credentials";
import type { HttpClient } from "./http";

export const LFS_JSON = "application/vnd.git-lfs+json";

/** Locks are checked on a fixed interval while the editor is in the foreground. */
export const LOCK_POLL_INTERVAL_MS = 60_000;

export interface FileLock {
  id: string;
  path: string;
  ownerName: string;
  lockedAt: string;
  ours: boolean;
}

/** `unsupported`: the host has no Git LFS locking API (404 or 501 from the locks endpoints). */
export type LockErrorKind = "conflict" | "offline" | "unauthorized" | "unsupported" | "http";

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

export interface VerifyOptions {
  /** The branch whose locks to list (an Integrated push's own); the provider's branch by default. */
  branch?: string;
}

export interface LockProvider {
  create(path: string): Promise<LockResult<FileLock>>;
  verify(options?: VerifyOptions): Promise<LockResult<{ ours: FileLock[]; theirs: FileLock[] }>>;
  unlock(id: string, options?: UnlockOptions): Promise<LockResult<void>>;
}

export interface GitLfsLockProviderOptions {
  repositoryUrl: string;
  /**
   * The branch lock requests name (`ref.name`), read on every request, so a
   * switch to another branch applies at once: the checked-out branch in
   * Integrated mode, the project's default branch otherwise.
   */
  branch: () => string;
  http: HttpClient;
  /** Read on every request, so a credential saved, refreshed or removed later applies at once. */
  credential: CredentialSource;
}

export interface GitConfigPrefill {
  repositoryUrl: string;
  branch: string;
}

export function isSourceControlHost(
  platform: string,
  testMode: boolean,
): boolean {
  if (testMode) return true;
  return platform === "ios" || platform === "android" || platform === "electron";
}

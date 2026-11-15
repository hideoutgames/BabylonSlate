// The editor's startup path imports this barrel; device sign-in, token refresh, the host
// REST APIs, the pushed-lock comparator, the fake host, the Git core (`./git`, which brings
// isomorphic-git), `./fake-sync` and `./git-benchmark` are subpath exports, so they load
// only with the screens that use them. `SyncPort`'s types and its small pure helpers (errors,
// Publish's `.gitattributes` and `.gitignore` text, the `.blobs` path rule) are here; its
// implementations are not.
export type {
  FileLock,
  GitConfigPrefill,
  GitLfsLockProviderOptions,
  LockError,
  LockErrorKind,
  LockProvider,
  LockResult,
  UnlockOptions,
} from "./types";
export { isSourceControlHost, LOCK_POLL_INTERVAL_MS } from "./types";
export type { HttpClient, HttpRequest, HttpResponse } from "./http";
export {
  authorizedHttp,
  commitAuthorFor,
  CREDENTIALS_SECRET_KEY,
  credentialAllowsOrigin,
  credentialHasHostApi,
  CredentialStore,
  credentialUsername,
  fixedCredential,
  GITHUB_ORIGIN,
  GITLAB_ORIGIN,
  tokenCredential,
  type CredentialKind,
  type CredentialSource,
  type HostCredential,
  type SecretPort,
} from "./credentials";
export {
  hostOrigin,
  lfsEndpointFromRepoUrl,
  parseRepositoryUrl,
  repositoryCloneUrl,
  type RepositoryLocation,
} from "./lfs-endpoint";
export { parseGitConfigPrefill } from "./git-config";
export { lfsObjectId } from "./lfs-pointer";
export type {
  ChangeKind,
  CommitAuthor,
  CommitInfo,
  CommitInput,
  CommitResult,
  FileChange,
  LogOptions,
  LogPage,
  PullChoice,
  PullChoices,
  PullConflict,
  PullInput,
  PullResult,
  PushResult,
  RemoteState,
  SwitchResult,
  SyncErrorCode,
  SyncErrorKind,
  SyncPort,
  SyncStatus,
  TransferOptions,
} from "./sync-port";
export {
  cancelledError,
  GITATTRIBUTES_LFS_RULE,
  GITIGNORE_ENTRIES,
  hasLfsRule,
  INCOMING_LIMIT,
  isSyncError,
  isValidBranchName,
  SyncError,
  throwIfCancelled,
  withIgnoreEntries,
  withLfsRule,
} from "./sync-port";
export { GitLfsLockProvider } from "./git-lfs-lock-provider";
export { FakeLockProvider } from "./fake-lock-provider";
export { LockPollScheduler } from "./poll-scheduler";

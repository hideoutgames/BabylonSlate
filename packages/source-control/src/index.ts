// The editor's startup path imports this barrel; device sign-in, token refresh, the host
// REST APIs, the pushed-lock comparator and the fake host are subpath
// exports, so they load only with the screens that use them.
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
export { GitLfsLockProvider } from "./git-lfs-lock-provider";
export { FakeLockProvider } from "./fake-lock-provider";
export { LockPollScheduler } from "./poll-scheduler";

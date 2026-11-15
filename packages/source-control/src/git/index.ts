// Integrated mode's Git core: load with `import("@haptic/source-control/git")` when a
// project's mode needs it, never from the editor's startup path. isomorphic-git and its
// `Buffer` global come with this entry only; `SyncPort`'s types are in the package barrel.
export {
  cloneRepository,
  DEFAULT_CLONE_DEPTH,
  GitRepository,
  initRepository,
  openRepository,
  type GitRepositoryOptions,
  type OperationCounters,
} from "./repository";
export {
  GITATTRIBUTES_LFS_RULE,
  GITIGNORE_ENTRIES,
  hasLfsRule,
  INCOMING_LIMIT,
  isSyncError,
  SyncError,
  withIgnoreEntries,
  withLfsRule,
} from "../sync-port";
export type { StorageFsCounters } from "./storage-fs";
export type { TransferCounters } from "./git-http";

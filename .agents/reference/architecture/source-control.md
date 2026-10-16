# Source Control

Optional Git LFS file locking: the `LockProvider` port, the LFS client, token storage, editor lock UX, and external-change detection by mtime.

## Decisions

- The engine is **not a git client**. It implements Git LFS locking only; clone, commit, pull, push and merge stay in Working Copy (iPad) or a desktop git client. It never reads git state or shows git status badges, and never adds `lockable` to `.gitattributes`.
- Per project and **off by default** (`ProjectSettings.sourceControl.enabled`). Off means no decoration, polling, token traffic, Locks window or any other behavioural difference.
- No source control on production web: GitHub LFS has no CORS and a proxy is out of scope. Native hosts bypass CORS (`CapacitorHttp`, Electron `net.fetch`). Test mode uses `FakeLockProvider`.
- Locks are **advisory** and failure never blocks editing. Release is explicit only (Release All My Locks or per asset), never on a timer, close or heuristic, because the engine cannot observe a push.
- External change is detected by file mtime on foreground, not by git.
- The token is never a `project.json` field. The package never imports Capacitor or Electron; `lfsFetch` and `getToken` are injected.

## Ownership

| Area | Source |
| --- | --- |
| `LockProvider`, `FileLock`, `LockError`, secret key prefix | [`types.ts`](../../../packages/source-control/src/types.ts) |
| Git LFS client | [`git-lfs-lock-provider.ts`](../../../packages/source-control/src/git-lfs-lock-provider.ts) |
| Fake provider | [`fake-lock-provider.ts`](../../../packages/source-control/src/fake-lock-provider.ts) |
| Endpoint derivation, `.git/config` prefill | [`lfs-endpoint.ts`](../../../packages/source-control/src/lfs-endpoint.ts), [`git-config.ts`](../../../packages/source-control/src/git-config.ts) |
| Poll scheduler | [`poll-scheduler.ts`](../../../packages/source-control/src/poll-scheduler.ts) |
| Settings normalize (`sourceControl`) | [`packages/core/src/project.ts`](../../../packages/core/src/project.ts) |
| SecretStore and native HTTP | [`packages/vfs/src/`](../../../packages/vfs/src/) `secret-store.ts`, `capacitor-secret-store.ts`, `electron-secret-store.ts`, `native-http.ts` |
| Desktop IPC (`secrets:*`, `lfs:fetch`) | [`apps/desktop/src/`](../../../apps/desktop/src/) `desktop-secret-store.ts`, `packaged-security.ts` |
| Editor service, path-keyed file ops, external change | [`apps/editor/src/`](../../../apps/editor/src/) `services/source-control-service.ts`, `lib/source-control-file-ops.ts`, `lib/external-change.ts` |
| mtime diff (`MANY_EXTERNAL_CHANGES` = 8) | [`mtime-diff.ts`](../../../packages/assets/src/mtime-diff.ts) |

## Port and client

- `LockProvider`: `create(path)`, `verify()` → `{ ours, theirs }`, `unlock(id, { force? })`. `LockError.kind` is `conflict` (409 with the existing lock), `offline`, `unauthorized` or `http`. `FileLock.lockedAt` is `""` when the server omits it (shown as Unknown Age).
- **Create is the race-free check**: 201 holds the lock. A 409 carries no ours/theirs, so `GitLfsLockProvider.create` then verifies: a path in `ours` is returned as held; otherwise it is a theirs conflict. If verify fails, the 409 stays a conflict.
- Calls go to `{lfsBase}/locks` with `application/vnd.git-lfs+json` and Basic auth `x-access-token:<PAT>`: `POST /locks`, `POST /locks/verify` (cursor pagination), `POST /locks/:id/unlock`. `ref.name` is `refs/heads/<branch>`.
- Lock state comes only from verify (`GET /locks` cannot tell ours from theirs). A malformed verify body or a repeated `next_cursor` is an `http` error, so a refresh keeps the last known locks.
- `lfsEndpointFromRepoUrl` derives `https://<host>/<path>.git/info/lfs` from the **configured** repository URL (HTTPS, SSH or scp-style; `http://` is upgraded, the token never goes over plain HTTP). `.git/config` + `HEAD` only prefill settings when readable; Working Copy exposes the working tree only.

## Secrets

- SecretStore key `source-control:<projectGuid>`. The stored credential is bound to the HTTPS origin it was saved for; a changed host cannot reuse it, and older unbound credentials are never sent.

| Host | SecretStore | HTTP |
| --- | --- | --- |
| iOS / Android | Keychain / Keystore via the first-party `BabylonSlateSecrets` plugin (not Preferences); the Swift file must be in the App target and `packageClassList` | `CapacitorHttp` |
| Electron | IPC `secrets:get/set/delete` to a serialized, versioned owner-only file, each value tagged plaintext or `safeStorage` ciphertext; read failures reject rather than reset | IPC `lfs:fetch` → `net.fetch` |
| Web | Unavailable; Source Control UI hidden | Unused |

Linux without a keyring stores new values with an explicit plaintext tag (accepted).

## Settings

`sourceControl: { enabled (false), repositoryUrl (""), branch ("main"), autoLockOnEdit (true), pollIntervalMs (60000, minimum 1000) }`. Missing settings normalize to disabled; a stray `token` field is dropped. Changing repository, branch or poll interval drops the old provider's locks and every read-only state.

## Editor behaviour

- `SourceControlService` builds the Git LFS provider only when enabled on iOS, Android or Electron (Fake in test mode) and disposes on Close Project.
- **Auto-lock** on the first mutating `applyGraphChange` / `applySceneChange` / `applyAssetDocumentChange` per path per session, after the plugin read-only check. Skip create when verify already lists the path as ours. 409 theirs or a network failure still applies the edit and shows a persistent banner.
- **Advisory open** always succeeds. A path locked by someone else opens in edit mode `readonly` (`DocumentLockEditMode`: `editable` / `readonly` / `edit-anyway`) with holder, age and **Edit Anyway**.
- Moves, renames and deletes are path-keyed over every contained asset: ours → lock new, then unlock old (`transferLock`, never releasing first); delete of ours unlocks (`releasePath`); theirs → refuse with the holder before mutating. Copy never transfers locks. A failed transfer is reported and never undoes the file move.
- While enabled, the Texture alignment pass never re-encodes older Textures in the background (it would race a teammate for the file); only user-initiated re-encodes run, and they count as edits for auto-lock.
- The Locks DockView window exists only when `sourceControl: true` is passed to `listDockWindows`. Content Browser tiles expose `data-lock-state` `mine` / `theirs`.
- `LockPollScheduler` ticks on subscribe, then every `pollIntervalMs`; pause/resume follow background/foreground and ticks never overlap. Failed checks keep the cached list as the last known result; superseded replies never replace current state.

## External change

- `IndexedAsset.mtime` comes from the registry walk. On foreground the editor rescans and diffs mtimes plus `project.json`. Editor saves recapture the snapshot (`refreshMtimeSnapshotAfterEditorSave`); the registry's own Texture writes fold in through `applyOwnAssetWrite` only if the file still had the snapshot mtime, so a teammate's change still counts.
- ≥ `MANY_EXTERNAL_CHANGES` assets or a changed `project.json` → **Reload Project**; dirty changed/deleted documents → Keep Edits vs Reload From Disk; clean ones → Reload From Disk.
- Reload never drops in-memory locks before the next verify; this covers a Working Copy branch switch while backgrounded.

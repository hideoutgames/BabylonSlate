# Source Control

Optional Git LFS file locking (Manual mode): the `LockProvider` port and LFS client, device credentials with GitHub and GitLab device sign-in, the host REST clients, editor lock UX in the pinned Source Control tab, and external-change detection by mtime.

This file describes what is built. Built-in Git (Integrated mode) is planned in [source-control-plan.md](../source-control-plan.md).

## Decisions

- Per project, `ProjectSettings.sourceControl.mode`: `off` (default), `integrated`, `manual`. **Off costs nothing**: `SourceControlService.configure` returns before loading credentials, HTTP or timers and emits nothing, and no tab, banner, phone button, lazy chunk or polling exists. Any other mode on a source-control host is *active*.
- **Manual**: another Git app (Working Copy, a desktop client) syncs; Haptic implements Git LFS locking only. It reads no git state beyond the `.git/config` prefill, shows no git status and never adds `lockable` to `.gitattributes`. `integrated` is a valid stored value but nothing syncs yet; it behaves as Manual for locks, and Project Settings offers only **Off** and **Manual**.
- No source control on production web: GitHub's LFS and REST endpoints send no CORS headers and a proxy is out of scope. Native hosts bypass CORS (`CapacitorHttp`, Electron `net.fetch`). Test mode uses `FakeLockProvider`, in-memory credentials and `FakeGitHost`.
- Locks are **advisory** and failure never blocks editing. Release is explicit only (per lock, **Release All My Locks**, **Release Pushed Locks**), never on a timer, close or heuristic.
- Credentials are **per device and host origin**, never per project and never in `project.json` or Git. Clerk's GitHub sign-in cannot supply them (Clerk keeps provider tokens server-side), so host sign-in is separate from the Haptic account.
- Every link (device sign-in or saving a token) shows the use-at-your-own-risk warning first; **Decline** stores nothing; acceptance is never remembered.
- Lock paths are repository-relative and the project folder is the repository root; Release Pushed Locks compares local and remote files on that assumption.
- No Haptic-run server or client secret: OAuth device flow with public clients. Client ids are build variables (`VITE_GITHUB_CLIENT_ID`, `VITE_GITLAB_CLIENT_ID`, read only in [`source-control-client-ids.ts`](../../../apps/editor/src/lib/source-control-client-ids.ts)); without one that host's Sign In is hidden and a pasted token still works. Test mode supplies a fixed id.
- External change is detected by file mtime on foreground, not by git.

## Ownership

| Area | Source |
| --- | --- |
| `LockProvider`, `FileLock`, `LockError` (`unsupported` kind), `LOCK_POLL_INTERVAL_MS`, `isSourceControlHost` | [`types.ts`](../../../packages/source-control/src/types.ts) |
| `HttpClient` port (with `disableRedirects`) | [`http.ts`](../../../packages/source-control/src/http.ts) |
| `HostCredential`, `CredentialStore`, `CredentialSource`, `authorizedHttp`, origin rule, Basic usernames | [`credentials.ts`](../../../packages/source-control/src/credentials.ts) |
| GitLab sign-in refresh (subpath `./token-refresh`) | [`token-refresh.ts`](../../../packages/source-control/src/token-refresh.ts) |
| Git LFS client | [`git-lfs-lock-provider.ts`](../../../packages/source-control/src/git-lfs-lock-provider.ts) |
| Repository URL parsing, LFS endpoint, `hostOrigin`, `.git/config` prefill | [`lfs-endpoint.ts`](../../../packages/source-control/src/lfs-endpoint.ts), [`git-config.ts`](../../../packages/source-control/src/git-config.ts) |
| Device sign-in (subpath `./device-flow`) | [`device-flow.ts`](../../../packages/source-control/src/device-flow.ts) |
| Restore drops windows a catalog no longer lists | [`shell/restored-dock-layout.ts`](../../../apps/editor/src/shell/restored-dock-layout.ts) |
| GitHub and GitLab REST (subpath `./host-api`) | [`host-api.ts`](../../../packages/source-control/src/host-api.ts) |
| Pushed-lock comparator (subpath `./pushed-locks`) | [`pushed-locks.ts`](../../../packages/source-control/src/pushed-locks.ts) |
| Fakes: `FakeLockProvider`; `FakeGitHost` and `MemorySecrets` (subpath `./fake-host`) | [`fake-lock-provider.ts`](../../../packages/source-control/src/fake-lock-provider.ts), [`fake-host.ts`](../../../packages/source-control/src/fake-host.ts) |
| Poll scheduler | [`poll-scheduler.ts`](../../../packages/source-control/src/poll-scheduler.ts) |
| Settings normalize (`sourceControl`) | [`packages/core/src/project.ts`](../../../packages/core/src/project.ts) |
| `SourceControlService`, `SourceControlHosts` port, sign-in prompt | [`services/source-control-service.ts`](../../../apps/editor/src/services/source-control-service.ts) |
| Device accounts and the pushed check (both lazy) | [`services/source-control-accounts.ts`](../../../apps/editor/src/services/source-control-accounts.ts), [`services/source-control-pushed.ts`](../../../apps/editor/src/services/source-control-pushed.ts) |
| Sync into the editor, tab visibility, polling pause | [`context/use-source-control-sync.ts`](../../../apps/editor/src/context/use-source-control-sync.ts) |
| Link warning, `useHostLink`, Sign In dialog, banner | [`apps/editor/src/components/`](../../../apps/editor/src/components/) `source-control-link.tsx`, `use-host-link.tsx`, `source-control-sign-in-dialog.tsx`, `source-control-sign-in-banner.tsx` |
| Engine Settings → Source Control (lazy) | [`engine-source-control-settings.tsx`](../../../apps/editor/src/components/engine-source-control-settings.tsx) |
| Project Settings → Source Control; its account-aware rows (lazy) | [`project-source-control-settings.tsx`](../../../apps/editor/src/components/project-source-control-settings.tsx) (state in `settings-modal.tsx`), [`project-source-control-host-fields.tsx`](../../../apps/editor/src/components/project-source-control-host-fields.tsx) |
| Locks window (lazy family `shell/asset-panels/source-control.ts`) | [`panels/locks-panel.tsx`](../../../apps/editor/src/panels/locks-panel.tsx) |
| Path-keyed file ops, external change | `apps/editor/src/lib/` `source-control-file-ops.ts`, `external-change.ts` |
| SecretStore and native HTTP | [`packages/vfs/src/`](../../../packages/vfs/src/) `secret-store.ts`, `capacitor-secret-store.ts`, `electron-secret-store.ts`, `native-http.ts` |
| Desktop IPC (`secrets:*`, `lfs:fetch`), device pages allowlist | [`apps/desktop/src/`](../../../apps/desktop/src/) `desktop-secret-store.ts`, `desktop-http.ts`, `packaged-security.ts` |
| mtime diff (`MANY_EXTERNAL_CHANGES` = 8) | [`mtime-diff.ts`](../../../packages/assets/src/mtime-diff.ts) |

## Loading

- The startup path imports only the `@haptic/source-control` barrel (provider, credential store, scheduler, types). Device sign-in, token refresh, the host REST clients, the comparator and the fake host are subpath exports kept out of the barrel, so the bundler splits them.
- The device accounts module loads on the first configure of an active project or with a Source Control settings page; the Engine Settings page, the Project Settings account rows, the Sign In dialog and the Locks window (`lazyPanel`) load on first use. `boot-imports.test.ts` pins this.

## Port and client

- `LockProvider`: `create(path)`, `verify()` → `{ ours, theirs }`, `unlock(id, { force? })`. `LockError.kind` is `conflict` (409 with the existing lock), `offline`, `unauthorized`, `unsupported` or `http`. `FileLock.lockedAt` is `""` when the server omits it (Unknown Age).
- **Create is the race-free check**: 201 holds the lock. A 409 carries no ours/theirs, so `create` then verifies: a path in `ours` is returned as held; otherwise it is a theirs conflict. If verify fails, the 409 stays a conflict.
- Calls go to `{lfsBase}/locks` with `application/vnd.git-lfs+json` and Basic `<credential.username>:<token>`: `POST /locks`, `POST /locks/verify` (cursor pagination), `POST /locks/:id/unlock`. `ref.name` is `refs/heads/<branch>`.
- **Missing lock support:** GitHub and GitLab (`github`, `gitlab`, `gitlab-token` credentials) always have the locking API, so there a 404 or 501 from create or verify is an `http` error, **Repository Not Found Or No Access** (a token that cannot see the repository), and checks continue on the normal schedule. On any other host it is `unsupported`: the service stops polling and auto-lock, and the Locks window shows **This Host Does Not Support File Locking.** Saving a different credential tries again. An unlock 404 is always an `http` error (the lock is gone).
- Lock state comes only from verify. A malformed verify body or a repeated `next_cursor` is an `http` error, so a refresh keeps the last known locks.
- `parseRepositoryUrl` maps the **configured** repository URL (HTTPS, SSH or scp-style) to an HTTPS origin and path; `http://` is upgraded and an `ssh://` user and port are dropped, as git-lfs does. The origin is the credential key.

## Credentials

- One `HostCredential { origin, username, token, kind, account?, refreshToken?, expiresAt? }` per HTTPS origin, all under the single SecretStore key `source-control:credentials` (one read lists them). `CredentialStore` caches reads, but every change (`update`) re-reads the stored secret, applies the change and writes, serialized in the process, so another window's write is never lost to a stale cache.
- `kind` and Basic username: `github` (device sign-in) `x-access-token`; `gitlab` (gitlab.com device sign-in) `oauth2`; `gitlab-token` (self-managed GitLab personal token) the fixed `haptic`; `token` (any other host) `x-access-token`. Only `github`, `gitlab` and `gitlab-token` have a host REST API (pickers, Release Pushed Locks).
- **Origin rule** (`authorizedHttp`): a token goes only to its own origin, plus `https://api.github.com` for a `https://github.com` credential (the one exception; GitLab's API shares its origin). Any other URL is refused before a request. Every credentialed request sets `disableRedirects`: Electron's `lfs:fetch` never follows redirects (`redirect: "error"`) and CapacitorHttp gets `disableRedirects`, so a 3xx comes back unfollowed. Git and LFS use Basic, REST APIs Bearer.
- Requests take their credential from a `CredentialSource` (`current`, `renew`); a 401 renews it and retries once.
- **Refresh** (`RefreshingCredentials`, owned by the accounts module): GitLab sign-in tokens expire (about 2 h) and come with a refresh token. A token within 2 min of `expiresAt` is refreshed before use, and a 401 refreshes once: `POST https://gitlab.com/oauth/token` with `grant_type=refresh_token`, `refresh_token`, `client_id` (non-confidential app, no secret). One refresh per origin is in flight. It first re-reads the stored credential and uses another window's refresh if there is one (GitLab spends the old refresh token). A rejected refresh, or a build without the GitLab client id, removes the credential (compare-and-remove on the refresh token), so the sign-in banner returns; a refresh that cannot reach the host keeps the credential and fails that request. The service keys its provider on the account, so a refreshed token keeps the provider and its locks. GitHub OAuth App tokens do not expire and are never refreshed.

| Host | SecretStore | HTTP |
| --- | --- | --- |
| iOS / Android | Keychain / Keystore via the first-party `BabylonSlateSecrets` plugin (not Preferences); the Swift file must be in the App target and `packageClassList` | `CapacitorHttp` |
| Electron | IPC `secrets:get/set/delete` to a serialized, versioned owner-only file, each value tagged plaintext or `safeStorage` ciphertext; read failures reject rather than reset | IPC `lfs:fetch` → `net.fetch` |
| Web | Unavailable; Source Control hidden | Unused |
| Test mode | `MemorySecrets` (nothing kept) | `FakeGitHost` |

Linux without a keyring stores new values with an explicit plaintext tag (accepted).

## Device sign-in

- GitHub: `POST https://github.com/login/device/code` (`client_id`, `scope=repo`), poll `POST https://github.com/login/oauth/access_token`; user `GET https://api.github.com/user` (`login`). gitlab.com: `POST https://gitlab.com/oauth/authorize_device` (`scope=api write_repository`), poll `POST https://gitlab.com/oauth/token`; user `GET https://gitlab.com/api/v4/user` (`username`). Polls use the device-code grant; errors are read from 200 (GitHub) and 400 (GitLab) bodies.
- Each poll waits the code's interval (5 s default) first; `authorization_pending` continues, `slow_down` adds 5 s, and `expired_token`, `access_denied`, the code's own expiry and cancellation stop. The clock is injected (`DeviceClock`).
- The verification page is hard-coded per host (`https://github.com/login/device`, `https://gitlab.com/oauth/device`), never taken from the response. Desktop admits exactly these two pages in `externalOpenUrl`; every host opens them with `window.open(…, "_blank")`, which Electron hands to `shell.openExternal` and the mobile WebViews to the system browser.
- Returning from the browser fires the mobile Homepage session check, which unmounts dialogs, so `useHostLink` holds `holdSessionCheck` from **Accept** until the Sign In dialog closes.
- Self-managed GitLab needs its own app registration, so it takes a personal token instead.

## Settings and UI

- `sourceControl: { mode ("off"), repositoryUrl (""), branch ("main"), autoLockOnEdit (true), releaseLocksAfterPush (true, Integrated only) }`. Unknown modes normalize to `off`; other fields are dropped. Polling uses the fixed `LOCK_POLL_INTERVAL_MS` (60 s). Changing repository or branch drops the old provider's locks and every read-only state.
- **Project Settings → Source Control:** Mode (**Off** / **Manual**), Repository, Branch, Account, **Auto-Lock On First Edit**; **Release Locks After Push** shows only for Integrated. Choosing Manual with an empty repository reads the `.git/config` prefill first and otherwise shows a field error; turning Off asks first. While the mode is not Off, the account-aware rows replace the URL field with a picker of every API account's repositories (plus **Use Typed URL**), and the branch field with the host's branches when the repository's host has an API credential.
- **Engine Settings → Source Control** (Projects group; hidden where source control is unavailable): Accounts (GitHub and GitLab rows, shown when signed in or when the client id exists), Self-Managed GitLab, Other Git Hosts.
- **Sign-in prompt:** an active project whose repository origin has no credential shows one banner above the documents (`SourceControlSignInBanner`); the service builds no provider and requests nothing until the accounts module reports a saved credential, and a removed credential drops the provider and brings the banner back. Sign In runs device sign-in for github.com and gitlab.com and opens Engine Settings → Source Control otherwise.
- **Saved layouts:** `DockviewShell` drops panels its kind's catalog no longer lists (function graph tabs excepted) and the groups and splits they leave empty before `fromJSON`, which otherwise rejects the whole layout for an unknown component.
- **Source Control tab:** the `source-control` chrome document (`SOURCE_CONTROL_ID`, a `ChromeDocumentKind` beside `content-browser`): non-closable, never persisted in `tabOrder`, pinned last (`pinStickyTabs`), drawn at the right end of the tab bar left of **Open Documents**; on phones a **Source Control** button beside the Content Browser button opens it. It exists only while the service is active (`DocumentService.setSourceControlTab`; `initializeFromProject` keeps it only for a project not Off). It is a DockView document whose catalog holds only **Locks**; no asset document lists Locks.
- **Release Pushed Locks** (Manual, API hosts only): one remote tree read per check (GitHub `GET /repos/{path}/git/trees/{branch}?recursive=1`; GitLab `GET /projects/:id/repository/tree?ref=…&recursive=true`, paged only until every wanted path is found), then each own-locked file hashed once: normal files by Git blob SHA-1, `**/.blobs/<sha256>` LFS objects by the blob SHA-1 of their pointer text from name and size. A path missing from the listing (or cut short) is Not Pushed. The Locks window checks when the set of own locks changes and on Refresh; the action re-checks and skips documents with unsaved edits. Own rows show **Pushed** / **Not Pushed**.

## Editor behaviour

- **Auto-lock** on the first mutating `applyGraphChange` / `applySceneChange` / `applyAssetDocumentChange` per path per session, after the plugin read-only check. Skip create when verify already lists the path as ours. 409 theirs or a network failure still applies the edit and shows a persistent banner.
- **Advisory open** always succeeds. A path locked by someone else opens in edit mode `readonly` (`DocumentLockEditMode`: `editable` / `readonly` / `edit-anyway`) with holder, age and **Edit Anyway**.
- Moves, renames and deletes are path-keyed over every contained asset: ours → lock new, then unlock old (`transferLock`, never releasing first); delete of ours unlocks (`releasePath`); theirs → refuse with the holder before mutating. Copy never transfers locks. A failed transfer is reported and never undoes the file move.
- While a project's mode is not Off, the Texture alignment pass never re-encodes older Textures in the background (it would race a teammate for the file); only user-initiated re-encodes run, and they count as edits for auto-lock. Content Browser tiles expose `data-lock-state` `mine` / `theirs`.
- `LockPollScheduler` ticks on start, then every 60 s; pause/resume follow background/foreground and `editorQuiet`, and ticks never overlap. Failed checks keep the cached list as the last known result; superseded replies never replace current state, and a verify reply that a local create or unlock overtook is requested again before it replaces the list. A refresh asks at most three times; when local lock changes overtake every reply, it keeps the cached list and its previous status and asks the scheduler for another tick, which waits for resume while paused.
- The Locks window re-renders only rows whose lock changed: `locks` is a stable snapshot until the list changes, and rows are memoized with primitive props.

## External change

- `IndexedAsset.mtime` comes from the registry walk. On foreground the editor rescans and diffs mtimes plus `project.json`. Editor saves recapture the snapshot (`refreshMtimeSnapshotAfterEditorSave`); the registry's own Texture writes fold in through `applyOwnAssetWrite` only if the file still had the snapshot mtime, so a teammate's change still counts.
- ≥ `MANY_EXTERNAL_CHANGES` assets or a changed `project.json` → **Reload Project**; dirty changed/deleted documents → Keep Edits vs Reload From Disk; clean ones → Reload From Disk.
- Reload never drops in-memory locks before the next verify; this covers a Working Copy branch switch while backgrounded.

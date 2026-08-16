# Source control locking (P15)

Spec: [engineplan.md](../engineplan.md) §12. Package: `@babylonslate/source-control`. Editor host: `SourceControlService` in `apps/editor`. Secrets and CORS-bypass HTTP live in `@babylonslate/vfs`.

The engine is **not** a git client. It implements Git LFS file locking only. Clone, commit, pull, push, and merge stay in Working Copy (iPad) or a desktop git client. Web production has no source control (GitHub LFS has no CORS). Playwright uses `/?test=1` / `VITE_TEST_MODE` with `FakeLockProvider`.

## Opt-in

Per-project, **off by default** (`ProjectSettings.sourceControl.enabled`). Disabled projects: no decoration, no poll, no token traffic, no Locks window, no behavioural difference. Solo Documents-tier iPad users never see it.

## Port (`LockProvider`)

```ts
interface FileLock {
  id: string;
  path: string;
  ownerName: string;
  lockedAt: string; // ISO
  ours: boolean;
}

interface LockProvider {
  create(path: string): Promise<Result<FileLock, LockError>>;
  list(): Promise<Result<FileLock[], LockError>>;
  verify(): Promise<Result<{ ours: FileLock[]; theirs: FileLock[] }, LockError>>;
  unlock(id: string, options?: { force?: boolean }): Promise<Result<void, LockError>>;
}
```

`LockError.kind` is `conflict` (HTTP 409 with the existing lock), `offline`, `unauthorized`, or `http`. Create **is** the race-free check: 201 holds the lock. HTTP 409 does not include ours/theirs, so `GitLfsLockProvider.create` then `POST /locks/verify`: if the path is in `ours`, create returns that lock as held (already-ours); otherwise the 409 payload is a theirs conflict. If verify itself fails (offline / unauthorized), the 409 stays a conflict rather than being treated as held. List and verify skip malformed lock objects; verify paginates with `next_cursor`.

Implementations: `GitLfsLockProvider` (injected `lfsFetch` + `getToken` — the package never imports Capacitor or Electron) and `FakeLockProvider` (in-memory map, 409 on double-create, force-unlock flag).

## Git LFS client

Four calls against `{lfsBase}/locks` with `Accept` / `Content-Type: application/vnd.git-lfs+json` and Basic auth (`x-access-token:PAT`):

| Call | HTTP |
| --- | --- |
| create | `POST /locks` `{ path, ref }` |
| list | `GET /locks` (cursor pagination) |
| verify | `POST /locks/verify` `{ ref }` — `ours` / `theirs` (holder names come from the server) |
| unlock | `POST /locks/:id/unlock` `{ force, ref }` |

`ref.name` is `refs/heads/{branch}` from Project Settings.

### URL derivation (`lfsEndpointFromRepoUrl`)

Endpoint comes from the **configured repository URL**, not from parsing `.git` (Working Copy exposes the working tree). Prefill from `.git/config` + `HEAD` when those files are readable (desktop); never required.

| Remote | LFS base |
| --- | --- |
| `https://github.com/org/repo` or `.git` | `https://github.com/org/repo.git/info/lfs` |
| `git@github.com:org/repo.git` / `ssh://git@github.com/org/repo.git` | same HTTPS host (a PAT is required) |
| GitLab / Gitea HTTPS or SSH | `https://{host}/{path}.git/info/lfs` |

## Secrets and native HTTP (`vfs`)

Token is **never** a `project.json` field. Key: `source-control:{projectGuid}`.

| Host | SecretStore | nativeHttp |
| --- | --- | --- |
| iOS / Android | Keychain / Keystore via first-party `BabylonSlateSecrets` Capacitor plugin (not Preferences). iOS: `BabylonSlateSecretsPlugin.swift` is in the App Xcode target and `packageClassList`. | `CapacitorHttp` (bypasses CORS) |
| Electron | IPC `secrets:get` / `secrets:set` / `secrets:delete` → `safeStorage` when encryption is available. If `safeStorage.isEncryptionAvailable()` is false (typical Linux without a keyring), the host stores the packed value unencrypted in `source-control-secrets.json` rather than refusing Save Token. | IPC `lfs:fetch` → `net.fetch` |
| Web | unavailable — Source Control UI hidden | unused |

## Settings (`project.json`)

```ts
sourceControl: {
  enabled: boolean;          // default false
  repositoryUrl: string;     // default ""
  branch: string;            // default "main"
  autoLockOnEdit: boolean;   // default true
  pollIntervalMs: number;    // default 60000
}
```

Missing settings normalize to disabled. Project Settings → **Source Control** (hidden on production web): Enable, Repository URL, Branch, Auto-Lock On First Edit, Poll Interval (seconds), Token (password field + Save / Clear). UI shows **Token Saved** / **Not Saved**, never the secret.

## Editor UX

`SourceControlService` constructs Git LFS (native) or Fake (test mode) only when `enabled` **and** the host is ios/android/electron (or test mode). Dispose on Close Project.

- **Auto-lock** on the first mutating `applyGraphChange` / `applySceneChange` / `applyAssetDocumentChange` (after the plugin read-only check). Once per path per session. If verify already lists the path as ours, create is skipped. 201 / already-ours (409 then verify lists the path as ours): held. 409 theirs or network failure: edit still applies; persistent unlocked banner. Failure never blocks.
- **Advisory open**: always succeeds. Theirs starts `lockEditMode: "readonly"` with holder + age banner and **Edit Anyway**. Ours / unlocked: normal edit.
- **Release is explicit only.** **Release All My Locks** (confirm: unpushed work becomes editable by others) plus per-asset Release. Nothing on timer, close, or heuristic. **Force Unlock** is for stale / others’ locks.
- **Moves / renames / deletes:** path-keyed. Asset rename, asset move, folder rename, folder move, and folder delete walk contained asset paths. Ours → unlock old + lock new (`transferLock`). Delete of ours unlocks the old path (`releasePath`) and does not create a new lock. Theirs → refuse with the holder name before mutating. Copy does not transfer locks.
- **Content Browser:** reserved `data-lock-slot` — ours `data-lock-state="mine"`; theirs `data-lock-state="theirs"` plus owner name; unlocked empty. No git modified/untracked badges.
- **Locks** DockView window (`id: "locks"`) is listed for every `DockviewDocumentKind` only when `sourceControl: true` is passed into `listDockWindows`. Off: zero Windows-menu difference. Empty list copy is **No Locks.**

### Poll (`LockPollScheduler`)

Tick on subscribe, then every `pollIntervalMs` (default 60s). `pause()` / `resume()`; no tick while paused. Editor: project open, Content Browser focus, manual Refresh, foreground = resume + immediate tick; background = pause.

## External change (mtime, not git)

`IndexedAsset.mtime` comes from `DirEntry` during registry walk. On lifecycle **foreground**, remount/rescan and diff mtimes (plus `project.json` mtime).

| Classification | Prompt |
| --- | --- |
| Many assets and/or `project.json` changed (`MANY_EXTERNAL_CHANGES` = 8) | **Reload Project** |
| Dirty open docs whose files changed | Keep Edits vs Reload From Disk |
| Clean open docs whose files changed | Reload From Disk |

Reload must not drop in-memory locks until the next verify poll. This is the acceptance path for a Working Copy branch switch while backgrounded.

Two-device GitHub lock visibility is **manual** native acceptance, not CI.

## Tests

Node: endpoint mapping, SSH→HTTPS, 201/409 create, 409 already-ours via verify, verify ours/theirs, unlock/force, pagination, fake, poll pause, settings normalize, mtime classify. jsdom: settings hidden on web, token not in `project.json`, auto-lock, skip create when already ours, 409 banner, CB `data-lock-state`, Locks **No Locks.** / Release All copy, readonly + Edit Anyway, rename/folder/move refused when theirs, lock transfer pairs, delete unlocks ours, iOS `BabylonSlateSecretsPlugin` in pbxproj + `packageClassList`, foreground dirty warning (`SelectableText` paths). Playwright `e2e/p15-source-control.spec.ts`: Fake enable → edit → mine decoration → Locks count → Edit Anyway → Release All confirm → mtime reload dialog. Desktop source-read: IPC channel names `secrets:*` and `lfs:fetch`; iOS App-target Keychain plugin in `project.pbxproj` / `packageClassList`. Two-device GitHub lock visibility is manual, not CI.

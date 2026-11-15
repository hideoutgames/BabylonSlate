# Source Control Plan

Deferred design for built-in Git: clone, pull, commit, push, diff and history inside Haptic, GitHub sign-in, and a simpler lock-only mode. None of it is built; [architecture/source-control.md](architecture/source-control.md) describes the lock-only feature that exists. Until a step of [Order](#order) is built, this file is the source of its decisions, and [engine-plan.md](engine-plan.md#source-control) points here.

## Scope

- In: Git over HTTPS with Git LFS in the iOS, Android and desktop apps; GitHub sign-in; cloning and publishing from the project browser; a Source Control window (changes, asset diffs, commit, pull, push, branches, history, revert); Git LFS locks in every mode; other Git hosts by URL and token.
- Out for now: the web build (GitHub's Git and LFS endpoints send no CORS headers, and a proxy is out of scope); SSH transport (SSH remotes map to their HTTPS host, as `lfsEndpointFromRepoUrl` already does); line-level merge, rebase, stash and submodules; non-Git systems such as Diversion or Perforce; source control providers in Engine Extensions.

## Modes

Per project (`project.json` `sourceControl.mode`), off by default.

| Mode | Syncs | Haptic does |
| --- | --- | --- |
| Off | Nobody | Nothing: no polling, credentials, network or UI difference |
| Integrated | Haptic | Clone, pull, commit, push, diff, history, branches, LFS transfer and locks |
| External | Working Copy or a desktop Git app | Locks only: today's feature, reworked ([External mode](#external-mode)) |

- One Git client per folder: Integrated projects come from Clone or Publish in app storage, and an existing working copy stays External, because two clients writing one index race. Working Copy exposes the working tree only, so its folders are always External.

## Hosts

- Sync and locks use only standard protocols: Git smart HTTP, the Git LFS batch API and the Git LFS locking API. No host REST API is in the sync path, so any host implementing them works.
- Host REST APIs serve convenience features only, and only GitHub's is used.

| Feature | GitHub | Other Git hosts |
| --- | --- | --- |
| Clone, pull, commit, push, diff, history | Yes | Yes |
| Branch list and switching | Yes | Yes (from the Git ref advertisement) |
| LFS storage and locks | Yes | Where the host implements them |
| Sign-in | GitHub sign-in | A token per host |
| Repository picker, Publish To GitHub | Yes | No: the repository is created on the host and its URL typed |
| Release Pushed Locks (External) | Yes | No |

- A host without the locking API (Bitbucket Cloud documents none; Azure Repos is unconfirmed) shows **This Host Does Not Support File Locking** instead of a lock error; sync still works.
- GitHub is supported and tested by hand; other hosts work through the standards and are not tested by Haptic. CI covers the protocols against a local Git HTTP server and a fake LFS server.

## Credentials and settings

- Engine Settings → **Source Control** (per device): GitHub **Sign In** / **Sign Out** with the signed-in user, and tokens for other hosts. Engine Settings is reachable from the Homepage and the editor; the Account dialog is not, because account UI unmounts on entering the editor.
- `SecretStore` holds one credential per device and host origin, replacing the per-project key (`source-control:<projectGuid>`). Credentials never enter `project.json` or Git.
- GitHub sign-in is its own flow: Clerk's GitHub sign-in cannot supply a token, because Clerk holds the provider token server-side and reading it needs the Clerk secret key.
- Returning from the sign-in browser fires the mobile Homepage session check, which unmounts open dialogs; the flow holds it with `holdSessionCheck`.
- Project Settings → Source Control: Mode, Repository, Branch, Auto-Lock On First Edit, and Release Locks After Push (Integrated). The Token field and Poll Interval go; polling keeps a fixed 60 s interval.
- Opening a project whose mode is not Off without a credential for its host shows one **Sign In** prompt instead of failing every request.

## Git and LFS

- isomorphic-git, with an `fs` adapter over project storage and its `http` over native HTTP. Rejected: host REST APIs for sync (per-host code, a hand-made index, no offline commits, request limits on large pushes) and the `git` binary on desktop (a second implementation; iOS has none).
- Clones are shallow and single-branch; history fetches deeper on demand.
- Blobs are LFS objects: `**/.blobs/<sha256>` files are raw chunk bytes named by their SHA-256, which is the LFS object id, and are never rewritten ([containers.md](architecture/containers.md)).
  - Commit stores a pointer for each `.blobs` file (oid from the name, size from stat); push uploads missing objects through the batch API before updating refs.
  - Pull and checkout download a `.blobs` object only when its file is missing.
  - Status compares `.blobs` files by name and size, never by Git blob hash.
- Git itself carries `.hasset` files (chunks under 64 KiB stay inline), `project.json`, plugin and extension files and `.haptic-folder` markers.
- Publish writes `.gitattributes` (`**/.blobs/** filter=lfs diff=lfs merge=lfs -text`) and `.gitignore` (`layout.json`, which holds one person's dock layout, plus the `.haptic-*.tmp` and `.haptic-move-*` files that storage writes and moves leave). `lockable` is still never added.

## Editor

- Project browser: **Clone From GitHub** (repository and branch pickers), **Clone From URL** (other hosts), and **Publish To GitHub** on an existing project (creates the repository, writes `.gitattributes` and `.gitignore`, commits and pushes). Clones go to app storage and open when done.
- **Source Control** window, listed only in Integrated mode (as Locks is listed only with source control on): changes by asset; **Commit** with a message; **Pull**; **Push**; branch switch and create; per-asset history and **Revert**.
  - An asset's change covers its `.hasset` file and the blobs it references; blobs are never listed alone.
- Diffs compare decoded assets, because `.hasset` is a binary container and Git's text diff says nothing: header payload fields and changed chunks first (Textures as before and after previews), then Scenes by actor id and graphs by node id. The base version comes from the Git object store.
- Conflicts are whole-file: per asset **Keep Mine** or **Take Theirs**; no textual merge. Locks keep conflicts rare.
- Pull and branch switch ask to save or discard dirty documents first, are confirmed and are not undoable (like asset file creation and deletion), and pass their changed paths to the external-change reload flow.

## Locks

- Every mode keeps today's lock behaviour: advisory, auto-lock on first edit, read-only open with **Edit Anyway**, path-keyed moves ([source-control.md](architecture/source-control.md#editor-behaviour)).
- Integrated push verifies locks first and refuses paths someone else holds. With **Release Locks After Push** (default on) it then releases the pushed paths' locks: Haptic made the push, so this is not the heuristic release the lock-only design forbids.
- **Release Pushed Locks** (External, GitHub only) is an explicit action. It releases a lock only when the local file matches the remote branch (Git blob hash for normal files; for LFS paths, the pointer's oid and size against the file's name and size) and skips documents with unsaved edits.

## External mode

Today's feature with: credentials from Engine Settings; the single **Sign In** prompt; Repository and Branch pickers when signed in to GitHub (the `.git/config` prefill stays); no Token or Poll Interval rows; **Release Pushed Locks**; the missing-lock-support message.

## Engine integration points

What exists today and what each part must change. Check these against the code before building; they are a starting map, not a contract.

- **Package:** `packages/source-control` holds the lock client (`GitLfsLockProvider`, Basic `x-access-token:<token>`), `lfsEndpointFromRepoUrl` and `LockPollScheduler`, and imports neither Capacitor nor Electron. The Git client and LFS transfer join it on the same terms: storage, HTTP and credentials injected.
- **Native HTTP:** `NativeHttp` (`packages/vfs/src/native-http-port.ts`) carries GET and POST with text bodies and returns `bodyText`; its only binary path is a single base64 image upload. Git smart HTTP needs binary request and response bodies, and LFS needs PUT and large binary transfers, so the port needs binary bodies and a streaming file transfer in the native plugins and the desktop IPC (`lfs:fetch`).
- **Credentials:** `sourceControlSecretKey(projectGuid)` (`packages/source-control/src/types.ts`) and `tokenForOrigin` (`apps/editor/src/services/source-control-service.ts`) become per-origin device credentials. Without a token, every lock request today fails `unauthorized` and the Locks window shows Lock Status Unavailable.
- **Sign-in browser:** `createAuthBrowser` (`@haptic/vfs`) and, on desktop, `authProviderUrl` (`apps/desktop/src/packaged-security.ts`), whose host allowlist must admit GitHub's sign-in host.
- **Settings:** `ProjectSettings.sourceControl` (`packages/core/src/project.ts`): `enabled` becomes `mode`, `pollIntervalMs` goes, `releaseLocksAfterPush` joins. The rows live in `apps/editor/src/components/project-source-control-settings.tsx`. Project setting changes follow the [FeatureTest starter rule](../rules/feature-test.md).
- **Assets:** `packages/assets/src/blob-store.ts` (write-once blobs, `BLOBS_DIR`), `hasset.ts` (container decode for diffs), `mtime-diff.ts` and `apps/editor/src/lib/external-change.ts` (reload after pull).
- **Windows:** `listDockWindows` lists Locks only with `sourceControl: true`; the Source Control window follows the same pattern.
- **Docs:** `docs/projects/source-control.md` and `docs/editor/settings.md` change with each step.

## Order

1. Gate on the A16 iPad: isomorphic-git clone, status, commit and push of a project with a few thousand assets through the Capacitor storage adapter, and LFS transfer of large blobs through native HTTP. Status must use stat data, not re-hashing. Choose the streaming transfer path from the results.
2. Device credentials, GitHub sign-in in Engine Settings and the External mode rework; update `architecture/source-control.md`.
3. Git core in `packages/source-control`: clone, status, commit, pull (fast-forward and whole-file conflicts), push and LFS transfer, tested against a local Git HTTP server and a fake LFS server.
4. Integrated mode in the editor: Clone From GitHub, Clone From URL, Publish To GitHub, the Source Control window, lock verify before push and release after it.
5. Asset diffs: payload and chunk level, then Scene and graph views.
6. Branches, history and revert.

## Open decisions

| Decision | Recommendation |
| --- | --- |
| GitHub app type | Check both against the native sign-in browsers and the LFS lock endpoint (Basic `x-access-token:<token>`) before choosing: a GitHub App limits access to chosen repositories; an OAuth App needs the broad `repo` scope |
| Adopting an existing desktop clone as Integrated | Allow on desktop when `.git` is readable, warning that no other Git app may use it at the same time |
| Web build | Stay out unless a proxy is accepted |
| Providers in Engine Extensions | No. A non-Git system such as Diversion needs a sync-level provider (status, update, commit, base version, locks, history), built first-party first |
| Diversion | Deferred until its public API offers locks |

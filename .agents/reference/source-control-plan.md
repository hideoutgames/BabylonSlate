# Source Control Plan

Deferred design for built-in Git (Integrated mode): clone, pull, commit, push, diff and history inside Haptic. [architecture/source-control.md](architecture/source-control.md) describes what is built: the modes setting, Manual mode (Git LFS locks only), device credentials with GitHub and GitLab sign-in, the link warning, the pinned Source Control tab holding **Locks**, and the [Git core](architecture/source-control.md#git-core) (clone, status, commit, pull, push and LFS transfer behind `SyncPort`, with its benchmark), which the editor does not use yet. Until a step of [Order](#order) is built, this file is the source of its decisions, and [engine-plan.md](engine-plan.md#source-control) points here.

## Scope

- In: Git over HTTPS with Git LFS in the iOS, Android and desktop apps; GitHub and GitLab sign-in; cloning and publishing from the project browser; a pinned Source Control tab (changes, asset diffs, commit, pull, push, branches, history, revert) and status bar controls; Git LFS locks in every mode; other Git hosts by URL and token.
- Out for now:
  - The web build: GitHub's Git and LFS endpoints send no CORS headers, and it stays out unless a proxy is accepted.
  - SSH transport: SSH remotes map to their HTTPS host, as `lfsEndpointFromRepoUrl` already does.
  - Line-level merge, rebase, stash and submodules.
  - Non-Git systems such as Diversion or Perforce. Diversion waits until its public API offers locks.
  - Source control providers in Engine Extensions. A non-Git system needs a sync-level provider (status, update, commit, base version, locks, history), which would be built first-party first.
- Free: no Haptic-run server, proxy or paid service. Repository and LFS storage, bandwidth and request limits fall on each user's own host plan.

## Modes

Per project (`project.json` `sourceControl.mode`), off by default.

| Mode | Syncs | Haptic does |
| --- | --- | --- |
| Off | Nobody | Nothing: no polling, credentials, network or UI difference |
| Integrated | Haptic | Clone, pull, commit, push, diff, history, branches, LFS transfer and locks |
| Manual | Working Copy or a desktop Git app | Locks only ([source-control.md](architecture/source-control.md)) |

- One Git client per folder, because two clients writing one index race. Integrated projects come from Clone or Publish in app storage. On desktop an existing clone whose `.git` is readable may switch to Integrated, with a warning that no other Git app may use it at the same time; elsewhere an existing working copy stays Manual. Working Copy exposes the working tree only, so its folders are always Manual.

## Hosts

- Sync and locks use only standard protocols: Git smart HTTP, the Git LFS batch API and the Git LFS locking API. No host REST API is in the sync path, so any host implementing them works.
- Host REST APIs serve convenience features only, and only GitHub's and GitLab's are used. GitLab's code serves gitlab.com and self-managed instances alike.

| Feature | GitHub | GitLab | Other Git hosts (Gitea, Forgejo, …) |
| --- | --- | --- | --- |
| Clone, pull, commit, push, diff, history | Yes | Yes | Yes |
| Branch list and switching | Yes | Yes | Yes (from the Git ref advertisement) |
| LFS storage and locks | Yes | Yes (exclusive locks are on every tier) | Where the host implements them |
| Sign-in | Device sign-in | Device sign-in on gitlab.com; instance URL and token when self-managed | A token per host |
| Repository picker, Publish | Yes | Yes | No: the repository is created on the host and its URL typed |
| Release Pushed Locks (Manual) | Yes | Yes | No |

- A host without the locking API (Bitbucket Cloud documents none; Azure Repos is unconfirmed) still syncs in Integrated mode; its locking is reported as unsupported, as in Manual.
- GitHub and GitLab are supported and tested by hand; other hosts work through the standards and are not tested by Haptic. CI covers the protocols against a local Git HTTP server and a fake LFS server, with no host accounts or tokens.

## Credentials and settings

- Credentials, sign-in and the link warning are built ([source-control.md](architecture/source-control.md#credentials)); Integrated mode uses the same per-origin credentials for Git smart HTTP and the LFS batch API.
- Project Settings → Source Control gains **Integrated** in Mode and shows **Release Locks After Push** (`releaseLocksAfterPush`, already in the settings model) for it.

## Git and LFS

Built as the [Git core](architecture/source-control.md#git-core); the decisions stay here for the steps that use it.

- isomorphic-git, with an `fs` adapter over project storage and its `http` over native HTTP. Rejected: host REST APIs for sync (per-host code, a hand-made index, no offline commits, request limits on large pushes) and the `git` binary on desktop (a second implementation; iOS has none).
- Clones are shallow and single-branch; history fetches deeper on demand.
- Blobs are LFS objects: `**/.blobs/<sha256>` files are raw chunk bytes named by their SHA-256, which is the LFS object id, and are never rewritten ([containers.md](architecture/containers.md)).
  - Commit stores a pointer for each `.blobs` file (oid from the name, size from stat); push uploads missing objects through the batch API before updating refs.
  - Pull and checkout download a `.blobs` object only when its file is missing.
  - Status compares `.blobs` files by name and size, never by Git blob hash.
- Git itself carries `.hasset` files (chunks under 64 KiB stay inline), `project.json`, plugin and extension files and `.haptic-folder` markers.
- Publish writes `.gitattributes` (`**/.blobs/** filter=lfs diff=lfs merge=lfs -text`) and `.gitignore` (`layout.json`, which holds one person's dock layout, plus the `.haptic-*.tmp` and `.haptic-move-*` files that storage writes and moves leave). `lockable` is still never added. A repository Publish did not create (a cloned one, or an adopted desktop clone) may lack the `.blobs` rule; the Git core refuses to commit `.blobs` until the rule is in place, and step 2 of [Order](#order) decides how the editor adds it.

## Editor

- Project browser: **Clone From GitHub** and **Clone From GitLab** (repository and branch pickers), **Clone From URL** (other hosts), and **Publish To GitHub** / **Publish To GitLab** on an existing project (creates the repository, writes `.gitattributes` and `.gitignore`, commits and pushes). Clones go to app storage and open when done.
- The pinned **Source Control** tab ([UI](#ui)): changes by asset; **Commit** with a message; **Pull**; **Push**; branch switch and create; per-asset history and **Revert**; diffs.
  - An asset's change covers its `.hasset` file and the blobs it references; blobs are never listed alone.
- Diffs compare decoded assets, because `.hasset` is a binary container and Git's text diff says nothing: header payload fields and changed chunks first (Textures as before and after previews), then Scenes by actor id and graphs by node id. The base version comes from the Git object store.
- Conflicts are whole-file: per asset **Keep Mine** or **Take Theirs**; no textual merge. Locks keep conflicts rare.
- Pull and branch switch ask to save or discard dirty documents first, are confirmed and are not undoable (like asset file creation and deletion), and pass their changed paths to the external-change reload flow.

## Locks

- Every mode keeps the built lock behaviour: advisory, auto-lock on first edit, read-only open with **Edit Anyway**, path-keyed moves ([source-control.md](architecture/source-control.md#editor-behaviour)).
- Integrated push verifies locks first and refuses paths someone else holds. With **Release Locks After Push** (default on) it then releases the pushed paths' locks: Haptic made the push, so this is not the heuristic release the lock-only design forbids.

## UI

Approved layouts. Everything keeps the editor's compact density, tokens and Lucide icons; assets show their usual type visuals; settings rows carry no explanatory text ([row descriptions](../rules/row-descriptions.md)).

- **Source Control tab** (built with **Locks**; [source-control.md](architecture/source-control.md#settings-and-ui)): in Integrated mode its tab shows the count of uncommitted changes, and diffs open inside it, never as separate document tabs. Its Integrated windows:
  - **Changes**, tabbed with **History** and **Locks**: branch picker; **Pull** and **Push** with counts; a status line (commits to pull and push, last check); changed assets as rows (include checkbox, type icon, folder, own-lock icon, A/M/D in success/warning/destructive); **Incoming** commits; the commit box (**Commit Message**, **Push After Commit**, **Commit N Assets**).
  - **Actors** (Scenes; the matching tree for other kinds): added, removed and changed items marked and tinted, unchanged ones muted, with search and Added/Removed/Changed counts.
  - **Diff**: the view for the asset's kind, with **Open <Kind>** and **Revert Asset**.
  - The global toolbar's document slot (where Compile or the scene mode picker sit) holds the **Base** and **Compare** pickers.
- **Phone layout:** it has no status bar, so **More Tools** holds the status bar menu's actions (the **Source Control** button beside the Content Browser button is built).
- **Diff views:**
  - Properties: Property, Base (branch and short id) and Working Copy columns grouped by component; changed cells tinted destructive (base) and success (working copy); **Side By Side** / **Inline**; **Changed Only**.
  - Graphs: **Overlay** / **Base** / **Working Copy**; changed nodes outlined warning, added success, removed destructive and dashed, each tagged; a changed pin value shows the old value struck through beside the new; a side list grouped by graph, Variables and Functions.
  - Textures: **Side By Side** / **Swipe** / **Difference** and **RGB** / **Alpha** over a checkerboard; size, file size, source, compression, sRGB and mipmaps compared; how many Materials use it.
- **Status bar** (Integrated): source control leads. A branch button opens **Commit…**, **Pull**, **Push**, **Refresh**, **Switch Branch**, **New Branch…**, **Open Source Control** and **Open History**; then **N Changes** (brings the tab forward), **Pull N** and **Push N**. Save state shrinks to **Saved** on the right; a transfer replaces Pull and Push with its progress; **Auto-Save Failed — Use Save All** still takes the right side.
- **Pull Conflicts** dialog: a row per asset with **Compare** and **Keep Mine** / **Take Theirs**; **Cancel Pull**; **Apply And Finish Pull** stays disabled, with the reason shown, until every asset has a choice.
- **History** window: the selected asset's commits (**This Asset** / **All Assets**), uncommitted changes first; the selected commit's message, author, time and short id (with copy), **Compare With Working Copy**, **Revert To This Version** and its assets; **Load Older History** at the end of a shallow clone.
- **Clone Project** (project browser): **GitHub** / **GitLab** / **URL**, the signed-in user, repository search and list (Private/Public, last update), **Branch**, **Project Name**, **Clone**.
- **Publish Project**: Host, Owner, Repository Name, Visibility (**Private** / **Public**), a summary of what it creates and pushes (asset count, size, the share through LFS), **Publish**.
- **Project Settings → Source Control**: Mode (**Off** / **Integrated** / **Manual**), with **Release Locks After Push** under Locking for Integrated.

## Engine integration points

What exists today and what each part must change. Check these against the code before building; they are a starting map, not a contract.

- **Package:** `packages/source-control` holds the lock client, credentials, device sign-in, the GitHub and GitLab REST clients, the poll scheduler and the Git core (`SyncPort`, subpath `./git`; `FakeSync`, subpath `./fake-sync`), and imports neither Capacitor nor Electron. The editor loads `./git` only for an Integrated project and tests on `FakeSync`.
- **Native HTTP:** `NativeHttp` (`packages/vfs/src/native-http-port.ts`) carries GET, POST and PUT with text or byte bodies and binary answers, whole ([binary HTTP](architecture/source-control.md#binary-http)). A streaming file transfer in the native plugins and the desktop IPC (`lfs:fetch`) waits for step 1's results.
- **Settings:** the Integrated rows live in `apps/editor/src/components/project-source-control-settings.tsx` (`OFFERED_MODES`). Project setting changes follow the [FeatureTest starter rule](../rules/feature-test.md).
- **Assets:** `packages/assets/src/blob-store.ts` (write-once blobs, `BLOBS_DIR`), `hasset.ts` (container decode for diffs), `mtime-diff.ts` and `apps/editor/src/lib/external-change.ts` (reload after pull).
- **Source Control tab:** the `source-control` DockView document (`SOURCE_CONTROL_WINDOWS` in `apps/editor/src/shell/window-catalog.ts`, panels in `shell/asset-panels/source-control.ts`); step 2 of [Order](#order) adds its other windows there, following the [DockView asset editor tabs rule](../rules/dockview-editor-tabs.md).
- **Status bar:** `apps/editor/src/components/editor-status-bar.tsx`, which renders nothing in the phone layout.
- **Docs:** `docs/projects/source-control.md` and `docs/editor/settings.md` change with each step.

## Order

1. The owner runs the Git benchmark on the A16 iPad; its results decide the native streaming path before Integrated mode ships. Run it against a repository with a few thousand assets ([benchmark](architecture/source-control.md#benchmark)); the unchanged status must read no files.
2. Integrated mode in the editor: the **Integrated** Mode option, Clone and Publish for GitHub and GitLab, Clone From URL, the Source Control tab's Changes, History, Actors and Diff windows, the status bar controls and the phone More Tools actions, lock verify before push and release after it.
3. Asset diffs: payload and chunk level, then Scene and graph views.
4. Branches, history and revert.

# Source Control Plan

Deferred design for the rest of built-in Git: asset diffs, history, branches and revert. [architecture/source-control.md](architecture/source-control.md) describes what is built: the modes (Off, Integrated, Manual), Manual mode's Git LFS locks, device credentials with GitHub and GitLab sign-in, the link warning, the [Git core](architecture/source-control.md#git-core) and [Integrated mode](architecture/source-control.md#integrated-mode) (Clone, Publish, the Changes window, commit, pull with whole-file conflicts, push with lock verify and release, the status bar and the phone More Tools actions). Until a step of [Order](#order) is built, this file is the source of its decisions, and [engine-plan.md](engine-plan.md#source-control) points here.

## Scope

- In: Git over HTTPS with Git LFS in the iOS, Android and desktop apps; GitHub and GitLab sign-in; cloning and publishing from the project browser; a pinned Source Control tab (changes, asset diffs, commit, pull, push, branches, history, revert) and status bar controls; Git LFS locks in every mode; other Git hosts by URL and token.
- Out for now:
  - The web build: GitHub's Git and LFS endpoints send no CORS headers, and it stays out unless a proxy is accepted.
  - SSH transport: SSH remotes map to their HTTPS host, as `lfsEndpointFromRepoUrl` already does.
  - Line-level merge, rebase, stash and submodules.
  - Non-Git systems such as Diversion or Perforce. Diversion waits until its public API offers locks.
  - Source control providers in Engine Extensions. A non-Git system needs a sync-level provider (status, update, commit, base version, locks, history), which would be built first-party first.
- Free: no Haptic-run server, proxy or paid service. Repository and LFS storage, bandwidth and request limits fall on each user's own host plan.

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

## Editor

- Diffs compare decoded assets, because `.hasset` is a binary container and Git's text diff says nothing: header payload fields and changed chunks first (Textures as before and after previews), then Scenes by actor id and graphs by node id. The base version comes from the Git object store (`SyncPort.readFile`).
- Branch switch asks to save or discard dirty documents first, is confirmed and is not undoable (like a pull), and passes its changed paths to the external-change reload flow (`applyPulledChanges`).
- Per-asset history and **Revert** in the Source Control tab.

## UI

Approved layouts. Everything keeps the editor's compact density, tokens and Lucide icons; assets show their usual type visuals; settings rows carry no explanatory text ([row descriptions](../rules/row-descriptions.md)).

- **Source Control tab** (built with **Changes** and **Locks**): diffs open inside it, never as separate document tabs. Its windows still to build:
  - **History**, tabbed with **Changes** and **Locks**.
  - **Actors** (Scenes; the matching tree for other kinds): added, removed and changed items marked and tinted, unchanged ones muted, with search and Added/Removed/Changed counts.
  - **Diff**: the view for the asset's kind, with **Open <Kind>** and **Revert Asset**.
  - The global toolbar's document slot (where Compile or the scene mode picker sit) holds the **Base** and **Compare** pickers.
  - **Changes** gains a branch picker in place of its branch label.
- **Diff views:**
  - Properties: Property, Base (branch and short id) and Working Copy columns grouped by component; changed cells tinted destructive (base) and success (working copy); **Side By Side** / **Inline**; **Changed Only**.
  - Graphs: **Overlay** / **Base** / **Working Copy**; changed nodes outlined warning, added success, removed destructive and dashed, each tagged; a changed pin value shows the old value struck through beside the new; a side list grouped by graph, Variables and Functions.
  - Textures: **Side By Side** / **Swipe** / **Difference** and **RGB** / **Alpha** over a checkerboard; size, file size, source, compression, sRGB and mipmaps compared; how many Materials use it.
- **Status bar** menu (built with **Commit…**, **Pull**, **Push**, **Refresh**, **Open Source Control**) gains **Switch Branch**, **New Branch…** and **Open History**; the phone's More Tools gains the same.
- **Pull Conflicts** (built) gains **Compare** on each row, opening the asset's diff.
- **History** window: the selected asset's commits (**This Asset** / **All Assets**), uncommitted changes first; the selected commit's message, author, time and short id (with copy), **Compare With Working Copy**, **Revert To This Version** and its assets; **Load Older History** at the end of a shallow clone (`SyncPort.log` with `deepen`).

## Engine integration points

What exists today and what each part must change. Check these against the code before building; they are a starting map, not a contract.

- **Package:** `packages/source-control` holds the Git core (`SyncPort`, subpath `./git`; `FakeSync`, subpath `./fake-sync`) with `readFile` and `log` ready for diffs and history; branch listing and switching need new `SyncPort` calls (and contract cases for both implementations).
- **Native HTTP:** `NativeHttp` (`packages/vfs/src/native-http-port.ts`) carries GET, POST and PUT with text or byte bodies and binary answers, whole ([binary HTTP](architecture/source-control.md#binary-http)). A streaming file transfer in the native plugins and the desktop IPC (`lfs:fetch`) waits for step 1's results.
- **Assets:** `packages/assets/src/hasset.ts` (container decode for diffs).
- **Source Control tab:** the `source-control` DockView document (`INTEGRATED_SOURCE_CONTROL_WINDOWS` in `apps/editor/src/shell/window-catalog.ts`, panels in `shell/asset-panels/source-control.ts`); History, Actors and Diff join that catalog, following the [DockView asset editor tabs rule](../rules/dockview-editor-tabs.md).
- **Sync service:** `apps/editor/src/services/source-control-sync.ts` gains branch switch (through the Pull flow's unsaved-document and reload steps) and history reads.
- **Docs:** `docs/projects/source-control.md` and `docs/editor/settings.md` change with each step.

## Order

1. The owner runs the Git benchmark on the A16 iPad; its results decide the native streaming path before Integrated mode ships. Run it against a repository with a few thousand assets ([benchmark](architecture/source-control.md#benchmark)); the unchanged status must read no files.
2. Asset diffs: the **Actors** and **Diff** windows, payload and chunk level, then Scene and graph views; **Compare** in Pull Conflicts; the **Base** and **Compare** pickers.
3. Branches, history and revert: the **History** window, the Changes branch picker, **Switch Branch**, **New Branch…** and **Open History** in the status bar menu and More Tools.

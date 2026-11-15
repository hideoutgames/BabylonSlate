# Source Control Plan

What remains of built-in Git before Integrated mode ships: the iPad benchmark and the native streaming path it decides, graph diffs on the canvas for every graph family, locks on the checked-out branch, loose blob clean-up and one picker follow-up. [architecture/source-control.md](architecture/source-control.md) describes what is built: the modes (Off, Integrated, Manual), Manual mode's Git LFS locks, device credentials with GitHub and GitLab sign-in, the link warning, the [Git core](architecture/source-control.md#git-core) and [Integrated mode](architecture/source-control.md#integrated-mode) (Clone, Publish, the Changes and History windows, commit, pull with whole-file conflicts, push with lock verify and release, branches, the status bar and the phone More Tools actions) and its [asset diffs](architecture/source-control.md#asset-diffs) (the Actors and Diff windows, the Base and Compare pickers, Revert Asset and Revert To This Version, Compare in Pull Conflicts). Until a step of [Order](#order) is built, this file is the source of its decisions, and [engine-plan.md](engine-plan.md#source-control) points here.

## Scope

- In: Git over HTTPS with Git LFS in the iOS, Android and desktop apps; GitHub and GitLab sign-in; cloning and publishing from the project browser; a pinned Source Control tab (changes, history, asset diffs, commit, pull, push, branches, revert) and status bar controls; Git LFS locks in every mode; other Git hosts by URL and token.
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

## UI

- The toolbar's **Base** and **Compare** pickers list the asset's last 20 commits (`commitsOf`), read when a menu opens. They should take their commit list from History's loaded pages for the same asset, so a commit History reached past the first 20 can be picked too, and both read the log once.
- **Graph diffs on the canvas for every graph family.** The approved design draws changed graphs as **Overlay** / **Base** / **Working Copy** on the graph canvas. Only Class and Scene script graphs do today; Material, Particle, Behaviour Tree and Animation graphs list their node changes as properties, because their node components load in their own editor chunks. Each family's read-only canvas joins the Diff window, loaded with that family's chunk.
- **Texture diff rows:** the design compares sRGB and mipmaps, which Texture assets do not store; the Diff shows **Usage** and **Downsample** instead. Rows for sRGB and mipmaps join it if Textures gain those settings.

## Locks and blobs

- **Locks on the checked-out branch.** Lock requests (create, verify, release) send the project's default branch (`sourceControl.branch`) as their ref. Since the checked-out branch is the working copy's HEAD, they should send HEAD's branch, so a host that scopes locks by ref checks the branch being pushed.
- **Loose blob clean-up.** A commit takes each asset's blobs from the header it commits, so a blob no asset references (left by a reverted or discarded edit, or a deleted asset) is never committed, but it stays in `.blobs` as an untracked file. A clean-up removes untracked `.blobs` files no asset header in any content root references, never one a commit holds.

## Engine integration points

What exists today and what each part must change. Check these against the code before building; they are a starting map, not a contract.

- **Native HTTP:** `NativeHttp` (`packages/vfs/src/native-http-port.ts`) carries GET, POST and PUT with text or byte bodies and binary answers, whole ([binary HTTP](architecture/source-control.md#binary-http)). A streaming file transfer in the native plugins and the desktop IPC (`lfs:fetch`) waits for step 1's results.
- **Docs:** `docs/projects/source-control.md` and `docs/editor/settings.md` change with each step.

## Order

1. The owner runs the Git benchmark on the A16 iPad; its results decide the native streaming path before Integrated mode ships. Run it against a repository with a few thousand assets ([benchmark](architecture/source-control.md#benchmark)); the unchanged status must read no files.
2. Locks on the checked-out branch and loose blob clean-up ([Locks and blobs](#locks-and-blobs)).
3. Graph diffs on the canvas for Material, Particle, Behaviour Tree and Animation graphs ([UI](#ui)).
4. The Base and Compare pickers take their commits from History ([UI](#ui)).

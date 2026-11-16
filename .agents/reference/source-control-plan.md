# Source Control Plan

What remains of built-in Git before Integrated mode ships: the iPad benchmark rerun on the native file transfer. [architecture/source-control.md](architecture/source-control.md) describes what is built: the modes (Off, Integrated, Manual), Git LFS locks (on the checked-out branch in Integrated mode), device credentials with GitHub and GitLab sign-in, the link warning, the [Git core](architecture/source-control.md#git-core) and [Integrated mode](architecture/source-control.md#integrated-mode) (Clone, Publish, the Changes and History windows, commit, pull with whole-file conflicts, push with lock verify and release, branches, Remove Unused Files, the status bar and the phone More Tools actions) and its [asset diffs](architecture/source-control.md#asset-diffs) (the Actors and Diff windows, the Base and Compare pickers over History's commit lists, Revert Asset and Revert To This Version, Compare in Pull Conflicts). Until a step of [Order](#order) is built, this file is the source of its decisions, and [engine-plan.md](engine-plan.md#source-control) points here.

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

- **Texture diff rows:** the design compares sRGB and mipmaps, which Texture assets do not store; the Diff shows **Usage** and **Downsample** instead. Rows for sRGB and mipmaps join it if Textures gain those settings.

## Engine integration points

What exists today and what each part must change. Check these against the code before building; they are a starting map, not a contract.

- **LFS transfer:** objects stream through the native file transfer where the host has one ([native file transfer](architecture/source-control.md#native-file-transfer)); `NativeHttp` carries Git packs and batch and lock requests whole ([binary HTTP](architecture/source-control.md#binary-http)), and LFS objects only where no native transfer exists (web).
- **Docs:** `docs/projects/source-control.md` and `docs/editor/settings.md` change with each step.

## Benchmark evidence

Why LFS objects stream natively: the owner's A16 iPad (TestFlight build), against a 374-file repository, on the whole-body path.

| Run | Result |
| --- | --- |
| 3 × 32 MiB LFS objects | Clone 9.5 s; unchanged status 135 ms with no file read (the gate passes); LFS upload 28 s, download 18 s; no failure. |
| 3 × 256 MiB LFS objects | The app ran out of memory and closed, on both tries, at a stage the benchmark could not report then. Whole bodies cross the Capacitor bridge as base64 (about three copies of an object in JavaScript), and the benchmark held all its objects in memory before writing them. |

The native file transfer (iOS, Android, desktop), objects made one at a time (natively on iOS and Android), the download into files and the per-stage record and memory peaks answer both.

## Order

1. The owner reruns the Git benchmark on the A16 iPad with 3 × 256 MiB objects on the native path, in a build made from this change (a new TestFlight build: the native plugin code changed). From **Debug > Run Git Benchmark…** with Debug Mode on, against a repository the account can push to: set **LFS Objects** 3 and **Object Size** 256 MiB, keep the app in the foreground until it finishes, and copy the results from its dialog ([benchmark](architecture/source-control.md#benchmark)). The summary must say **LFS Transfer** native and the unchanged status must read no files; the peak memory per stage shows what each step cost. If the app closes, reopen the dialog: it names the stage the run stopped in. Delete the `haptic-benchmark-…` branch on the host afterwards.

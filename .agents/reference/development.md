# Development

Commands and environments for working on Haptic from this repository.

## Commands

```bash
pnpm install
pnpm dev                 # editor dev server, localhost:5173 only
pnpm dev --host          # also expose it on the local network (opt-in)
pnpm docs:dev            # docs site from docs/
pnpm test <files>        # focused unit tests (always name files; see testing.md)
pnpm build:pages         # production editor + docs site, as deployed to GitHub Pages
```

`pnpm dev` first bundles the player (`vite build`, with the player build's own checks), which the dev server serves at `/player/` for Preview Build and Export, and does not type-check it: the IDE, `pnpm typecheck --filter player` and the CI typecheck report type errors.

Local verification policy and the full command list: [testing.md](testing.md).

## Pages preview

- Pushes to `main` deploy the editor to `https://hideoutgames.github.io/BabylonSlate/` and the docs site to `/BabylonSlate/docs/` (`.github/workflows/preview.yml`).
- The Pages build is the production editor (`VITE_TEST_MODE=false`): it has no test-mode storage or test hooks and ignores `?test=1`. Test mode (no folder prompts, Create Project prefills TestProject) is for the dev server (`?test=1`) and Playwright builds.
- The production editor chunks differently from the test-mode builds the browser tests load, so a chunk fault can reach Pages with every e2e shard green. Preview fails the deploy, and Verify's `static` job fails, when a built chunk reads a binding across a chunk import cycle while it evaluates ([bundle rules](architecture.md#bundle-chunk-and-worker-rules)); after `pnpm build:pages`, `node scripts/chunk-cycles.mjs apps/editor/dist` runs the same check. `pnpm test:e2e` runs it on each test-mode build it makes, before publishing it ([testing.md](testing.md#local-test-execution)).
- The docs site writes `sitemap.xml` and each page's canonical, OpenGraph and Twitter tags with its Pages URL (`SITE_URL` in `apps/docs/.vitepress/config.ts`), whatever base a build uses. It has no `robots.txt`: crawlers read one only at the host root, which a project Pages site cannot serve.
- Pages source must stay **GitHub Actions**. Switching it to "Deploy from a `/docs` folder" would replace the editor with Jekyll-rendered Markdown.
- If the Preview workflow fails with a 404 deployment error, Pages is not enabled: Settings → Pages → Source: GitHub Actions, then re-run Preview.

## Physical iPad on the local network

1. `pnpm dev --host` (player: `pnpm --filter player dev --host`; port 5174).
2. Open the printed Network URL in Safari on the iPad; allow incoming connections in the firewall.
3. Stop the server when done. Never use `--host` on untrusted networks.

A plain-HTTP LAN origin is not a secure context: service workers and the cross-origin isolation shim behave differently from the HTTPS Pages preview.

## Manual iPad checklist (about 5 minutes)

1. Homepage in test mode (dev server with `?test=1`); Create Project prefills TestProject.
2. Toolbar: Save All, Undo/Redo, Play, Windows, Focus, Search, Settings.
3. Scene viewport (2D/3D toggle) and graph document tabs.
4. Content Browser lists project assets.
5. Play overlay opens and closes with **Stop**.
6. Long-press a tab header to drag panels.
7. Two-finger pan/orbit in the viewport; pan/pinch on a graph.

## Native storage checks (device or simulator)

CI compiles the storage plugins but runs no native code; check these by hand after changing them ([binary storage transport](architecture/vfs.md#binary-storage-transport)):

1. Create, save, close and reopen a project with a large asset (tens of MB): it round-trips, and Safari or Chrome remote inspection shows `haptic-storage://` (iOS) or `/_haptic_storage/` (Android) requests rather than base64 plugin calls.
2. iOS Files app, On My iPad > Haptic: projects appear; `__haptic_derived__` does not. In the app container, `Library/Application Support/Haptic` exists and is excluded from backup.
3. A project in a chosen iCloud Drive folder with an evicted file: opening it downloads the file without a stall of several seconds per file.
4. Open a chosen folder, return to the Homepage, open another: both work, and repeated switching never ends in **Reconnect Project**.
5. Kill the app during a save: the file holds the old or the new contents, never a truncated one, and no `.haptic-<uuid>.tmp` appears in the Content Browser.
6. Peak memory while opening and saving the large asset (Xcode memory gauge, Android Studio profiler) stays near twice the file size.

## Native shells (Capacitor)

```bash
pnpm --filter editor ios:sync && pnpm --filter editor exec cap open ios          # needs a Mac with Xcode
pnpm --filter editor android:sync && pnpm --filter editor exec cap open android  # needs the Android SDK
```

- `ios:sync` / `android:sync` build the editor (with the embedded player) and run `cap sync`. `ios:sync` then restores the custom Secrets, ScopedStorage, AudioLifecycle, Memory, FileExport and AuthSession plugin classes in `capacitor.config.json`: never run `cap sync ios` directly.
- `--demo` (`pnpm --filter editor ios:sync --demo`, `android:sync --demo`) builds with `VITE_MOBILE_DEMO=true`, so the app skips the required sign-in for simulator and emulator testing. A later sync without it restores sign-in; distribution builds refuse it. For `ios:build` / `android:build`, set `VITE_MOBILE_DEMO=true` in the environment.
- Social sign-in returns through `haptic://sso-callback` ([accounts](architecture/accounts.md#social-sign-in)): simulator and emulator builds receive it, the Electron app only when packaged on macOS and Linux, and every Clerk instance needs the redirect on its mobile SSO allowlist.
- `ios:build` / `android:build` add an unsigned simulator build / debug APK. Signing, archives and uploads are distribution operations: [distribution.md](distribution.md) and [the distribution rule](../rules/distribution.md).

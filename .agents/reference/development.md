# Development

Commands and environments for working on Haptic from this repository.

## Commands

```bash
pnpm install
pnpm dev                 # editor dev server, localhost:5173 only
pnpm dev --host          # also expose it on the local network (opt-in)
pnpm docs:dev            # docs site from docs/
pnpm test <files>        # focused unit tests (always name files; see testing.md)
pnpm build:pages         # editor (test mode) + docs site, as deployed to GitHub Pages
```

Local verification policy and the full command list: [testing.md](testing.md).

## Pages preview

- Pushes to `main` deploy the editor to `https://hideoutgames.github.io/BabylonSlate/` and the docs site to `/BabylonSlate/docs/` (`.github/workflows/preview.yml`).
- The Pages build runs in test mode (`VITE_TEST_MODE`): no folder prompts, Create Project prefills TestProject. `?test=1` behaves the same.
- Pages source must stay **GitHub Actions**. Switching it to "Deploy from a `/docs` folder" would replace the editor with Jekyll-rendered Markdown.
- If the Preview workflow fails with a 404 deployment error, Pages is not enabled: Settings → Pages → Source: GitHub Actions, then re-run Preview.

## Physical iPad on the local network

1. `pnpm dev --host` (player: `pnpm --filter player dev --host`; port 5174).
2. Open the printed Network URL in Safari on the iPad; allow incoming connections in the firewall.
3. Stop the server when done. Never use `--host` on untrusted networks.

A plain-HTTP LAN origin is not a secure context: service workers and the cross-origin isolation shim behave differently from the HTTPS Pages preview.

## Manual iPad checklist (about 5 minutes)

1. Homepage in test mode; Create Project prefills TestProject.
2. Toolbar: Save All, Undo/Redo, Play, Windows, Focus, Search, Settings.
3. Scene viewport (2D/3D toggle) and graph document tabs.
4. Content Browser lists project assets.
5. Play overlay opens and closes with **Stop**.
6. Long-press a tab header to drag panels.
7. Two-finger pan/orbit in the viewport; pan/pinch on a graph.

## Native shells (Capacitor)

```bash
pnpm --filter editor ios:sync && pnpm --filter editor exec cap open ios          # needs a Mac with Xcode
pnpm --filter editor android:sync && pnpm --filter editor exec cap open android  # needs the Android SDK
```

- `ios:sync` / `android:sync` build the editor (with the embedded player) and run `cap sync`. `ios:sync` then restores the custom Secrets, ScopedStorage, AudioLifecycle and Memory plugin classes in `capacitor.config.json`: never run `cap sync ios` directly.
- `ios:build` / `android:build` add an unsigned simulator build / debug APK. Signing, archives and uploads are distribution operations: [distribution.md](distribution.md) and [the distribution rule](../rules/distribution.md).

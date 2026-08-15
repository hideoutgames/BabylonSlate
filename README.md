# BabylonSlate

BabylonJS Editor optimised for Touch Devices — an iPad-first game engine with a shadcn React UI, Dockview panel layout, React Flow visual scripting, and Capacitor native shells.

**Engine plan:** [docs/engineplan.md](docs/engineplan.md) — architecture, roadmap, and delivery checklist. Appendix A is the slice checklist.

**Docs site:** [https://hideoutgames.github.io/BabylonSlate/docs/](https://hideoutgames.github.io/BabylonSlate/docs/) — VitePress site generated from `docs/`.

## Stack

- **Monorepo**: pnpm workspaces
- **App**: `apps/editor` — Vite + React + Capacitor 8
- **UI**: shadcn/ui (`packages/ui`) + Dockview
- **Engine**: Babylon.js 9 (`packages/render`)
- **Graph**: React Flow (`packages/graph-ui`) + `@babylonslate/scripting`
- **Storage**: OPFS on web; Capacitor Filesystem / scoped storage on iOS (`packages/vfs`)

## Project structure

```
apps/editor/          Capacitor shell, Homepage, Dockview, Play overlay
apps/docs/            VitePress site (content lives in docs/)
packages/core/        GUIDs, schemas, command bus, storage port
packages/vfs/         File adapters, platform detection, app settings
packages/assets/      .babasset / .babproject, registry, importers
packages/edit/        Per-document undo
packages/object-model/ World, actors, tick, class registry
packages/physics/     Havok 3D + Rapier 2D (game worker)
packages/bridge/      SAB + transferable transports
packages/runtime/     Game worker + in-process driver
packages/debugger/    Console command registry, BDebugCommand, stats HUD helpers, trace recorder (P8)
packages/ui-runtime/  Widget tree, anchors, layout (P9)
packages/anim-graph/  AnimationGraph evaluator (P9)
packages/shader-graph/ Shader IR (P9)
packages/input/       Action/axis mappings
packages/render/      Snapshot sync, resource cache, editor tools, FontFace registry, Babylon GUI
packages/scripting/   Graph IR, validator, JS codegen
packages/scripting-nodes/ Node catalog
packages/graph-ui/    React Flow graph editor
packages/ui/          shadcn primitives
packages/editor-kit/  Property grid, tree view, sheets
packages/test-kit/    Fixtures and deterministic harness
```

See [docs/architecture/overview.md](docs/architecture/overview.md) for the live package map.

## Project file format

Projects are `.babproject` containers (directory or zip). Editor scenes and graphs are `.babasset` files under `assets/`, with large payloads in `assets/.blobs/<sha256>`. Details: [docs/architecture/containers.md](docs/architecture/containers.md).

## Development

```bash
pnpm install
pnpm dev          # start Vite dev server
pnpm docs:dev     # VitePress docs site from docs/
pnpm verify       # typecheck + lint + unit tests + Playwright E2E + docs build
pnpm test         # unit tests only
pnpm test:e2e     # Playwright smoke tests (CI runs this)
```

## Testing on iPad (no Mac)

Automated tests run in GitHub Actions — you do not need a Mac or local terminal.

### GitHub Pages preview

After pushes to `main`, the app deploys to:

**https://hideoutgames.github.io/BabylonSlate/**

Open that URL in **Safari on your iPad**. The Pages build has test mode on (`VITE_TEST_MODE`) — no folder prompts, and Create Project prefills TestProject.

Documentation is on the same Pages site at **[/docs/](https://hideoutgames.github.io/BabylonSlate/docs/)**. Do not switch Pages source to “Deploy from a `/docs` folder” — that would replace the editor with Jekyll-rendered markdown.

You can also append `?test=1` if needed; both URLs behave the same on the deployed preview.

#### One-time setup (repo admin)

If the **Preview** workflow fails with a 404 deployment error, GitHub Pages is not enabled yet:

1. Open [BabylonSlate → Settings → Pages](https://github.com/hideoutgames/BabylonSlate/settings/pages)
2. Under **Build and deployment**, set **Source** to **GitHub Actions**
3. Re-run the failed **Preview** workflow (Actions → Preview → Re-run all jobs), or push any commit to `main`

To verify the Pages build locally:

```bash
pnpm build:pages
```

That builds the editor and the VitePress docs site, then copies docs into `apps/editor/dist/docs/`.

### Manual checklist (~5 min)

1. Homepage with test mode on; Create Project prefills TestProject
2. Toolbar: Save All, Undo/Redo, Play, Windows, Focus, Search, Settings
3. Scene Viewport (2D/3D toggle) and Graph document tabs
4. Content Browser lists project assets
5. Play overlay opens and closes with the top-right X
6. Long-press a tab header to drag panels
7. Two-finger pan/orbit in the Viewport; pan/pinch on a graph

### Automated coverage

| Layer | Tool | What it tests |
|-------|------|----------------|
| Packages | Vitest (node / jsdom / babylon) | VFS, assets, object model, physics, bridge, runtime, scripting, render (`NullEngine`) |
| Editor shell | Playwright (CI) | Homepage, chrome, Play, Content Browser, graph, scene editing |
| Docs | VitePress build + sidebar tests | `docs/` pages listed in `apps/docs/src/sidebar.ts` |

See [docs/architecture/testing.md](docs/architecture/testing.md). iOS Capacitor / Files App device spikes remain under `p1-device-spikes`.

## iOS (Capacitor) — requires Mac

```bash
cd apps/editor
pnpm build
npx cap sync ios
npx cap open ios
```

Requires Xcode. The scoped-storage plugin needs these `Info.plist` keys:

```xml
<key>LSSupportsOpeningDocumentsInPlace</key>
<true/>
<key>UISupportsDocumentBrowser</key>
<false/>
```

## Adding shadcn components

```bash
npx shadcn@latest add <component> -c apps/editor
```

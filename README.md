# BabylonSlate

BabylonJS Editor optimised for Touch Devices — an iPad-first game engine with a shadcn React UI, Dockview panel layout, React Flow visual scripting, and Capacitor native shells.

## Stack

- **Monorepo**: pnpm workspaces
- **App**: `apps/editor` — Vite + React + Capacitor 7
- **UI**: shadcn/ui (`packages/ui`) + Dockview
- **Engine**: BabylonJS (`packages/engine`)
- **Graph**: React Flow (`packages/graph`)
- **Storage**: `@daniele-rolli/capacitor-scoped-storage` on iOS/Android, web adapter for dev/CI

## Project structure

```
apps/editor/          Capacitor shell, Dockview layout, panels
packages/engine/      Babylon scene lifecycle
packages/graph/       React Flow editor + execution
packages/shared/      Types, project schema, command bus
packages/storage/     Platform file adapters
packages/ui/          shadcn components
```

## Project file format

```
MyGame.babylonslate/
  project.json
  layout.json
  graphs/main.graph.json
  scenes/main.scene.json
```

## Development

```bash
pnpm install
pnpm dev          # start Vite dev server
pnpm verify       # typecheck + lint + unit tests + Playwright E2E
pnpm test         # unit tests only
pnpm test:e2e     # Playwright smoke tests (CI runs this)
```

## Testing on iPad (no Mac)

Automated tests run in GitHub Actions — you do not need a Mac or local terminal.

### GitHub Pages preview

After pushes to `main`, the app deploys to:

**https://hideoutgames.github.io/BabylonSlate/?test=1**

Open that URL in **Safari on your iPad**. Test mode skips folder prompts and uses a fixed test project.

### Manual checklist (~5 min)

1. Toolbar and **Test mode** badge visible
2. Dockview tabs: Viewport, Graph, Hierarchy, Inspector
3. Spinning cube in Viewport
4. Tap **Open** — project name shows `TestProject.babylonslate` (no prompt)
5. Tap **Save** — no errors
6. Long-press a tab header to drag panels
7. Pan in Graph panel; touch-orbit in Viewport

### Automated coverage

| Layer | Tool | What it tests |
|-------|------|----------------|
| BabylonJS engine | Vitest + NullEngine | Scene loading, mesh creation (no WebGL) |
| Graph, storage, project | Vitest | Serialization, command bus, save/load |
| App shell | Playwright (CI) | Toolbar, Open/Save, canvas mount |

iOS Capacitor / Files App testing is deferred until Mac/Xcode is available.

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

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
pnpm verify       # typecheck + lint + test
```

## iOS (Capacitor)

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

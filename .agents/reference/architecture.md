# Architecture

One-page map of Haptic for contributors: where code lives, how data flows, and the coding, performance and gesture rules every change must keep.

Product decisions and their reasons: [engine-plan.md](engine-plan.md). Per-subsystem notes: [architecture/](architecture/). Package import boundaries are enforced by `no-restricted-imports` in `eslint.config.js`; read them there. Code identifiers keep the `@haptic/*` scope.

## Package map

| Package | Owns |
| --- | --- |
| [core](../../packages/core/src/) | GUIDs, `Result`, math, seeded RNG, zod schemas, document and asset kinds, engine component catalog, `engineCommandBus`, the `ProjectStorage` port, `formatValue`, Print HUD registry |
| [vfs](../../packages/vfs/src/) | Storage adapters (OPFS, Capacitor, Electron IPC, Node, memory), `createStorage()`, `getHostPlatform()`, app settings, secret store, native HTTP, Save Game storage |
| [assets](../../packages/assets/src/) | `.hasset` codec, project folder/zip backends, content-root-aware header-only registry, search index, importers, texture encode queue and import worker |
| [edit](../../packages/edit/src/) | Per-document undo stacks, reversible commands with merge keys, crash-recovery journal and replay |
| [object-model](../../packages/object-model/src/) | Headless `BObject` / Actor / ActorComponent / World, class registry, interfaces, subsystems, deterministic tick |
| [scripting](../../packages/scripting/src/) | Graph IR, pin types and assignability, pure validator, JS code generator with anchor tables |
| [scripting-nodes](../../packages/scripting-nodes/src/) | Data-driven node catalog (definition + codegen per node) |
| [input](../../packages/input/src/) | Raw input ring, action/axis mapping model, `InputResolver` |
| [runtime](../../packages/runtime/src/) | Game worker entry and in-process driver, ScriptHost, snapshot publisher, runtime subsystems |
| [physics](../../packages/physics/src/) | Body/shape protocol; Havok 3D (Physics V2 on a worker-local NullEngine), Rapier 2D, software test backend |
| [bridge](../../packages/bridge/src/) | SAB seq-lock and transferable transports, snapshot layout, typed channel messages |
| [render](../../packages/render/src/) | Babylon view: Engine/Scene lifecycle, snapshot apply, ResourceCache, render scheduler, editor tools and gizmos, material/particle lowering, audio and particle services, KTX2 transcode, font registry |
| [debugger](../../packages/debugger/src/) | Console command registry, parser, tiers, `BDebugCommand` helpers, stats, trace recorder |
| [anim-graph](../../packages/anim-graph/src/) | Animation Graph model and worker evaluator |
| [behaviour-tree](../../packages/behaviour-tree/src/) | Tree IR, blackboard, explicit-stack evaluator, tree validation |
| [navigation](../../packages/navigation/src/) | Recast bake/query port, 2D axis remap, Scene navmesh chunk |
| [shader-graph](../../packages/shader-graph/src/) | Material and Material Function IR, validator, lowering (Babylon-free) |
| [particle-graph](../../packages/particle-graph/src/) | Particle Graph IR, catalog, validator, compile key (Babylon-free) |
| [exporter](../../packages/exporter/src/) | Headless game packer: export closure, `game.json` catalog, zip |
| [source-control](../../packages/source-control/src/) | Git LFS locking client behind `LockProvider`, plus a fake |
| [ui](../../packages/ui/src/) | shadcn primitives and design tokens |
| [editor-kit](../../packages/editor-kit/src/) | Reusable editor components and touch hooks: property grid, tree view, pickers, panel frame, context menu, `SelectableText`, `WindowedList` |
| [graph-ui](../../packages/graph-ui/src/) | React Flow editor shell shared by every node graph |
| [test-kit](../../packages/test-kit/src/) | Golden-file helpers, fixtures, deterministic and multi-transport harnesses |

| App or folder | Role |
| --- | --- |
| [apps/editor](../../apps/editor/src/) | Vite + React + Capacitor host: Homepage, editor shell, services, Play overlay, main-thread renderer |
| [apps/player](../../apps/player/src/) | Packaged game host for exports and the Preview Build iframe; Babylon, no React or editor chrome |
| [apps/desktop](../../apps/desktop/) | Electron main/preload for the editor; Node VFS and userData |
| [apps/docs](../../apps/docs/) | Documentation site |
| [engine-content](../../engine-content/), [engine-plugins](../../engine-plugins/), [engine-extensions](../../engine-extensions/) | Bundled default content, first-party plugins, first-party editor extensions |

## Threading and data flow

```
React UI ── edit commands ──▶ DocumentEditingService / DocumentService ──▶ edit stacks + journal ──▶ ProjectStorage
   │  light UI → viewport messages: engineCommandBus ──▶ editor viewport (render)
   │  Play: PlayContentService collects the open scene, assets and compiled scripts
   ▼
bridge host (game-worker-host.ts) ── control msgs + tick-stamped input ring ──▶ game worker
                                                                          (driver: input → scripts → physics → publish)
   ◀── pose snapshots (SAB or transferable)  +  ordered commands (spawn, assignMesh, playSound, print, …)
   ▼
render: snapshot apply + command handlers on the Play Scene of the shared Engine ──▶ registerView canvas
```

- One Engine per open project; editor viewports, Prefab/Material previews and overlay Play are Scenes or views on it. Preview Build runs `apps/player` in an iframe with its own Engine.
- The game worker owns simulation: scripts, physics, navigation, Animation Graph and behaviour-tree evaluation. The main thread owns rendering, audio and fonts. Nothing Babylon crosses into the worker except physics on its private NullEngine.
- Poses travel only through the snapshot buffer; structural changes travel only as ordered commands. Graph execution emits commands and never touches Babylon.
- Owners: worker hosts in [apps/editor/src/services](../../apps/editor/src/services/) (`game-worker-host.ts`, `play-session.ts`, `input-capture.ts`), worker side [worker-entry.ts](../../packages/runtime/src/worker-entry.ts) and [driver.ts](../../packages/runtime/src/driver.ts), main-thread apply [snapshot-apply.ts](../../packages/render/src/snapshot-apply.ts).

### Core routing rules

- **`engineCommandBus`** ([command-bus.ts](../../packages/core/src/command-bus.ts)) carries light, synchronous UI → editor-viewport messages (logs, drop queries). It is not a Play path; Play traffic goes through the bridge.
- **`ProjectStorage`** ([storage-port.ts](../../packages/core/src/storage-port.ts)) obtained from `createStorage()` is the only file access: binary, range-capable, adapter-agnostic. Panels never call OPFS, Electron or Capacitor directly.
- **`getHostPlatform()`** ([platform.ts](../../packages/vfs/src/platform.ts)) is the only platform detection; Capacitor imports stay inside `vfs` adapters.
- Document mutations go through `edit` commands (`applyGraphChange` / `applySceneChange` / `applyAssetDocumentChange`); with source control on, the first mutating apply auto-locks the document.

## Bundle, chunk and worker rules

- The boot path (`main.tsx` → `App` → `DocumentProvider`) must not statically import the heavy barrels `@haptic/render`, `/runtime`, `/physics` or `/navigation`; they drag Babylon into the entry's preload closure. Import leaf deep exports instead (for example `@haptic/render/png-encode`, `/scene-load-readiness`, `/lifecycle-pause`, `/gl-error-trace`, `/ktx2-transcoder`; `@haptic/physics/component-props`; `@haptic/navigation/chunk`, `/settings`; `@haptic/runtime/component-authoring`). A deep-exported module must not import Babylon or a heavy barrel.
- Viewport, Play and import code is reached only from the lazy Editor route and may import full barrels.
- A lazy route chunk that fails to download must not leave a blank page: `main.tsx` installs `installPreloadErrorReload` (first `vite:preloadError` of a session reloads, guarded in `sessionStorage`), and `RouteErrorBoundary` wraps `LauncherTransitionProvider` in `AppRoutes` so its splash cannot cover the Reload action, and releases the boot intro (`releaseBootIntro`). Babylon's own shader-chunk imports retry on the next compile and are not part of this.
- The boot intro is static markup, styles and a start script in `apps/editor/index.html`, outside `#root`, so it keeps playing while the bundle evaluates and React never replaces it mid-flight. `LauncherTransitionProvider` drives that element through `useBootIntro` (`components/boot-intro.ts`) and removes it after the first transition; later project opens use the React card. Moving layers animate only `transform` and `opacity`, and the wordmark layers are `<img>` elements, because a CSS `url()` image becomes paintable only after a main-thread task. When the wordmark is not loaded at parse time, `data-wait` holds the letters (not the edges) until its `load` event and moves `data-start`, from which the provider counts the boot minimum (`MINIMUM_MS`, longer than the project-open card's).
- The built editor has a chunk import cycle (`document-context` → `render` → helpers in `editor-route`). Never read another chunk's value at module scope (`const ROOT = PROJECT_CONTENT_ROOT_ID`, top-level calls); read at render or call time. Vitest's unbundled modules will not catch this.
- Workers build as ES modules: construct every Vite-bundled worker with `{ type: "module" }`. Heavy optional runtimes (Rapier, Recast) stay separate chunks loaded by `import()` on first use. Classic workers (`public/basis/encode-worker.js`) load by URL and are not bundled.
- New asset editors are DockView documents wired through `window-catalog.ts`, `panel-registry.tsx`, `document-workspace.tsx` and `documentKindForAssetType` ([dockview-editor-tabs.md](../rules/dockview-editor-tabs.md)).
- Editor state subscriptions: read the narrowest hook (`useOpenDocument`, `useOpenDocumentsOfKinds`, state slices); `useDocumentActions()` is identity-stable; `useDocuments()` is deprecated. A component that calls an action during render must also subscribe to the state its result depends on. Registry-derived views key on `[assetRegistry, registryEpoch]`.
- Runtime driver subsystems register once in `RuntimeSubsystems`; constructors build only their own state, call no host callback and emit nothing; every command goes through the driver's `emit()`; Stop and Scene replacement iterate the registry instead of hand-written call lists.

## Coding standards

TypeScript

- `verbatimModuleSyntax`: use `import type` for type-only imports.
- DOM APIs take ArrayBuffer-backed views: helpers allocating fresh bytes return `Uint8Array<ArrayBuffer>`; copy with `bytes.slice()` when an owned buffer is needed; never pass SharedArrayBuffer-backed views.
- Prefer `Result` and explicit errors over throwing in pure packages. No `any` without a one-line justification.

React and editor UI

- Compose from `@haptic/ui` and `@haptic/editor-kit`; forms use `Field` + shadcn inputs; docked panels use `PanelFrame` / `ToolbarStrip`. No raw styled `<input>`, `<select>`, `<textarea>` or `<button>` in `apps/editor/src`.
- Semantic tokens only (no raw hex); edit tokens only in `packages/ui/src/styles/tokens.css` (imported by `globals.css`). Radius tokens only. `flex` + `gap-*`, not `space-y-*`.
- `--chrome-row` 28px for chrome and rows; graph pin rows 44px. Keep compact desktop density.
- Wrap copyable read-only text in `SelectableText`.
- Follow the Rules of React even though lint enables only `rules-of-hooks` and `exhaustive-deps`: no ref reads or global mutation during render, no `setState`-in-effect to mirror props.
- The Homepage stylesheet (`homepage.css`, `.homepage-theme`) is the only scoped exception to editor palette, radius and density rules; it never changes global editor tokens.
- User-facing labels are Title Case with preserved acronyms; identifiers stay unchanged ([display-names.md](../rules/display-names.md)).
- Babylon work follows the BabylonJS skill; editor chrome is never Babylon GUI.
- Never generate artwork, icons, models or video ([no-ai-artwork.md](../rules/no-ai-artwork.md)).

Tests and delivery

- Behaviour changes need meaningful tests in the owning package; goldens for byte-exact surfaces (containers, compiler output); TDD for new pure logic.
- Never lower a coverage threshold to go green; split out the untestable part instead.
- jsdom lacks `PointerEvent` and `ResizeObserver`: make DOM and gesture tests assert something real.
- Local checks are targeted only; CI owns exhaustive checks ([agent-workflow.md](../rules/agent-workflow.md#verification)).
- One roadmap slice per PR. Behavioural, API and format changes update documentation in the same change ([docs.md](../rules/docs.md)); engine feature changes also update the Feature Test starter ([feature-test.md](../rules/feature-test.md)).

## Performance rules

Budgets and defaults live in [engine-plan.md](engine-plan.md#baseline-device-and-performance-budget-rules). Rules for every change:

- Render resolution is owned through `setHardwareScalingLevel` (`adaptToDeviceRatio: false`); the dynamic valve trusts presentation and GPU signals only for Play-mode handles, and editor viewports feed CPU cost only. MSAA stays off on the iPad baseline.
- `skipPointerMovePicking` stays on for every scene except overlay SceneLayer Play scenes.
- Visible editor viewports render at the Engine Settings cap and freeze when hidden, obstructed, modal-covered or backgrounded; never dirty-skip a visible viewport. Play uses the project frame cap.
- Pause the render loop, game worker and encode queue on `visibilitychange` / app background.
- While Play or Preview Build covers the editor, editor background work waits on one flag, `editorQuiet` ([`editor-quiet.ts`](../../apps/editor/src/lib/editor-quiet.ts), set by the Play session provider; a Simulation never sets it): auto-save (a save that comes due starts a new interval once the editor is back), thumbnail captures (`whenEditorAwake`), the asset previews (`watchBlockingEditorOverlay` counts it as open), the water preview, source-control lock polling and the foreground rescan. The editor stays mounted, so returning to it is instant. New background editor work checks the same flag instead of adding its own.
- Construct asset textures only through `ResourceCache` (one per Engine); renderer-owned dynamic targets account bytes through `beginManagedRenderAllocation`. Never create a second Engine for a preview or Play session.
- Respect the document working set (idle unmount, warm cap, open Scenes always mounted); a CSS freeze is not a substitute for unmount.
- Window long lists with `WindowedList` / `windowedSlice`; never add a virtualizer library; Place Actors, Add Component and Settings catalogs stay unwindowed.
- No per-actor per-frame allocation in snapshot apply: reuse scratch math objects; copy into owned buffers instead of `slice()`; each snapshot identity applies once per frame.
- HUDs and overlays never `setState` or rewrite chrome DOM at 60 Hz.
- Worker tick: no whole-world work or per-actor allocation unless its output needs it. Compose world poses once per published frame through `WorldTransformComposer`; other passes compose only the actors they read; reuse driver-owned scratch collections; guard rules with deterministic counts, not timings.
- Quality settings are settings-time only: never re-resolve, invalidate readiness or dirty materials per frame. Features that are off or out of view plan, allocate and run nothing.
- Every scene mutation that should appear must invalidate the viewport.
- Quote performance only from measurements on the stated hardware; desktop and software-renderer runs are not device results.

## Gesture rules

Touch is primary; never assume hover or right-click. Hooks live in [editor-kit](../../packages/editor-kit/src/).

- The touch layout (Compact Mode off; [theming](architecture/theming.md#density-and-touch)) gets 44pt hit areas or a touch-specific layout, never larger desktop controls; Compact Mode keeps every surface compact, phones included. Gestures below follow the real pointer whatever the density. Expanded hit areas must not overlap neighbouring controls; switch to a touch layout when dense controls leave no room.

- Long-press (500 ms, cancelled by 8px movement or scroll, matching Dockview) opens context menus; `contextmenu` is the mouse path. The native menu is suppressed app-wide (`useSuppressNativeContextMenu`); inputs, `contenteditable` and `SelectableText` keep the platform menu.
- iOS three-finger undo/redo is suppressed outside text editing (`useSuppressIosEditingGestures`); editor canvases `preventDefault` touch with non-passive listeners and use `touch-none`.
- The shell never scrolls as a page: `overflow: hidden` + `overscroll-behavior: none` at the root, `contain` only on intentional scroll regions, `usePreventDocumentOverscroll` on coarse pointers.
- Do not autofocus search in catalog dialogs on touch (the keyboard covers them); Global Search may.
- Dock panel content is a gesture-safe zone; no floating or popout dock groups on iOS/Android.
- Viewport: one-finger tap picks (never hover); 3D drag looks, 2D drag pans; hold then move marquees; a second finger cancels a pending hold or marquee; pinch/wheel zoom; three fingers fly (3D) or pan (2D). Gizmo hits win over look/pan; a gizmo release is not a pick; a gizmo drag is one undo entry.
- Graphs: tap-to-connect and drag-to-connect both persist; a second pointer cancels a wire drag; drags and pinches that start on a wire pan and zoom (`patches/@xyflow__react@12.11.2.patch` drops XYFlow's hardcoded edge `nopan`; keep it when upgrading); a tap still selects the wire; double-tap does not zoom; hold-to-marquee uses the custom overlay, never XYFlow `selectionOnDrag`. Behaviour trees never break structural edges on release.
- Lists: `TreeView` drags start after 8px (mouse) or a 250 ms hold (touch/pen) so early movement scrolls; scrollable rows and slider tracks stay `touch-pan-y`; only the slider thumb changes value on touch.
- Selection: tap replaces; long-press or right-click on an unselected item replaces the selection, on a selected item keeps the group. The Class tree follows this and adds **Select** / **Deselect** to the hold menu, since touch has no modifier and swipe-add is off in a tree that drags out. In the Outliner the drop target decides meaning (row middle nests, top/bottom edge inserts as sibling, folders group, actor rows parent).

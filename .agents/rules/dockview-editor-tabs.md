# DockView asset editor tabs

An asset editor tab is a **DockView** document (`DockviewShell`), so its panels resize, dock beside each other and can take extra tabs later. Every document kind belongs in `DOCKVIEW_KINDS`; there is no non-DockView fallback page. The toolbar **Windows** menu works only for kinds in `DockviewDocumentKind`, so a disabled Windows menu or a missing panel means the wiring is incomplete.

## Required wiring, in one change

1. Add the kind to `DockviewDocumentKind` / `DOCKVIEW_KINDS` in `apps/editor/src/shell/window-catalog.ts`.
2. Add its `DockWindowDefinition[]` (stable `id`, `component`, Title Case `title`, `defaultPosition` relative to the primary panel) and the primary panel id in `DOCK_PRIMARY_PANEL`.
3. Register each `component` in `apps/editor/src/shell/panel-registry.tsx`.
4. Build the panels with `PanelFrame`, under `apps/editor/src/panels/` or in the asset editor's own file; omit a title DockView already shows.
5. Mount `DockviewShell` for the kind in `apps/editor/src/components/document-workspace.tsx` with the real `documentKind`, never the scene or graph fallback.
6. Map the asset type in `documentKindForAssetType` (`packages/core/src/document.ts`).
7. Cover the catalog in `apps/editor/src/shell/window-catalog.test.ts`.

`WindowsMenu`, `layout.json` persistence and the Focus fallback (`primaryDockPanel(kind)`) need no per-kind code; a restored layout takes each window's current catalog `title`.

## Rules

- Never use shadcn `Tabs` or hand-rolled split panes as the document layout. Nested `Tabs` may switch mutually exclusive modes inside one panel.
- The Animation Graph is the one exception: its **State Machine | Animation Object** mode bar (`AnimEditorModeBar`) sits outside DockView above two stacked DockView surfaces saved separately in `layout.json`; Windows and Focus follow the active mode.
- Content Browser stays a pinned chrome tab, not a DockView document.

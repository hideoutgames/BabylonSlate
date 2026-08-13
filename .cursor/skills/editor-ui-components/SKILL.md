---
name: editor-ui-components
description: Look up the Editor UI component catalog before building editor chrome, panels, dialogs, forms, trees, property grids, catalogs, search, or graph UI. Use when adding or changing apps/editor UI, @babylonslate/ui, editor-kit, or graph-ui. Read docs/architecture/components.md to choose existing reusable components instead of custom markup.
---

# Editor UI components

Do not invent Editor chrome. **Read the catalog first**, then compose from what is already there.

## Required first step

Read [`docs/architecture/components.md`](../../../docs/architecture/components.md) in full. That file is the live inventory of reusable Editor UI: what each component does and where it is used.

Do not rely on memory of an older catalog. Do not copy the tables into this skill.

## Choose from the catalog

Match the task to a row:

| Need | Typical catalog pick |
| --- | --- |
| Docked panel chrome | `PanelFrame`, optional `ToolbarStrip` |
| Details / typed properties | `PropertyGrid`, `NumericDragField`, `NumberField` |
| Hierarchy / folders | `TreeView` |
| Searchable pick lists | `SearchInput`, `SearchDialog`, `SearchDropdown`, `AssetPicker`, `CatalogDialog`, `CatalogItemButton` |
| Forms / settings | `Field` + `Input` / `Select` / `Switch` / `Checkbox` / `Textarea` |
| Actions / pressed tools | `Button` (outline vs ghost), `Toggle` / `ToggleGroup`, `IconActionButton` |
| Confirm / blocking | `AlertDialog`; inline status `Alert` |
| Empty / loading | `Empty`, `Skeleton` |
| Type glyphs | `TypeVisualIcon` |
| Graph canvas | `GraphEditor`, `NodePalette` |
| Readable copy in the shell | `SelectableText` |
| Long-press menus | `ContextMenuOverlay` + `useContextMenu` (not raw `ContextMenu`, except Homepage tiles) |

If several rows could fit, prefer the **more specific composite** (`CatalogDialog` over a one-off `Dialog` + search field).

## Do not

- Raw styled `<input>`, `<select>`, `<textarea>`, or `<button>` in `apps/editor/src`
- A new widget when the catalog already covers the job
- One-off screens treated as kit (Homepage, Play overlay, Settings modals, dock panels)

If nothing in the catalog fits, add a real reusable component in the right package, then update the catalog in the **same change** (`.cursor/rules/editor-ui-components.mdc`). Kit primitives/composites also go in the Component Gallery (`/?test=1&gallery=1`).

## Imports

- Primitives: `@babylonslate/ui/components/<name>`
- Composites: `@babylonslate/editor-kit`
- Graph: `@babylonslate/graph-ui`
- App wrappers: relative imports under `apps/editor/src/components/`

## Related

- Styling / shadcn composition: `.cursor/skills/shadcn/SKILL.md`
- Tokens: `docs/architecture/theming.md`
- Touch targets: `.cursor/rules/touch-editor.mdc`
- Title Case labels: `.cursor/rules/display-names.mdc`

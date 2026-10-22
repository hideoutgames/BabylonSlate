---
name: editor-ui-components
description: Look up the Editor UI component catalog before building editor chrome, panels, dialogs, forms, trees, property grids, catalogs, search, or graph UI. Use when adding or changing apps/editor UI, @haptic/ui, editor-kit, or graph-ui. Read .agents/reference/components.md to choose existing reusable components instead of custom markup.
---

# Editor UI components

Do not invent editor chrome. Read the catalog first, then compose from what is already there.

## Required first step

Read [components.md](../../reference/components.md) in full, including its Rules section. It is the live inventory of reusable editor UI: what each component does and where it is used. Do not rely on memory of an older catalog.

## Imports

- Primitives: `@haptic/ui/components/<name>`
- Composites: `@haptic/editor-kit`
- Graph: `@haptic/graph-ui`
- App wrappers: relative imports under `apps/editor/src/components/`

## Related

- Adding or changing a reusable component: [components.md](../../reference/components.md#rules)
- shadcn composition and styling: [shadcn skill](../shadcn/SKILL.md)
- Tokens and density: [theming.md](../../reference/architecture/theming.md)
- Touch and gestures: [architecture.md](../../reference/architecture.md#gesture-rules)
- Title Case labels: [display-names.md](../../rules/display-names.md)
- Asset document docks: [dockview-editor-tabs.md](../../rules/dockview-editor-tabs.md)

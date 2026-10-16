---
name: shadcn
description: shadcn/ui primitives for Haptic's editor chrome in packages/ui (Base UI, base-nova style, Tailwind v4, lucide icons). Use when adding, updating, composing or styling a shadcn component, changing theme tokens, or running the shadcn CLI, together with the editor-ui-components skill.
---

# shadcn/ui

shadcn/ui components are source files that the CLI copies into a project. Here they form `@babylonslate/ui`, the primitive layer of the editor chrome. This skill covers what differs from upstream shadcn; the rule files hold the Incorrect/Correct examples.

## This repo

- **Components** live in `packages/ui/src/components/`. Import them as `@babylonslate/ui/components/<name>`, or `#components/<name>` inside `packages/ui`. `cn` comes from `@babylonslate/ui/lib/utils` (`#lib/utils` inside the package).
- **Config**: `packages/ui/components.json` and `apps/editor/components.json` both use style `base-nova`, Tailwind v4 (no `tailwind.config`), CSS variables and the `lucide` icon library (`lucide-react`). The editor config points `ui` and `utils` at `packages/ui`, so CLI output lands there.
- **Primitives are Base UI** (`@base-ui/react`); nothing imports Radix. Upstream examples written for Radix (`asChild`, `type="single"`, string `defaultValue`) do not apply. See [rules/base-ui.md](rules/base-ui.md).
- **Theme tokens** live in `packages/ui/src/styles/tokens.css`, which `globals.css` imports. See [customization.md](customization.md).
- **Not present**: registries, presets, chat components, toast or sonner, Spinner, InputGroup, Avatar, Combobox, RadioGroup and the shadcn MCP server. Do not import them or follow upstream advice that assumes them; adding one is a new component (see Workflow).
- **Dependency**: `shadcn` ^4.16.2 is a dependency of `packages/ui` because `globals.css` imports `shadcn/tailwind.css`.
- **Density**: compact toolbars use `size="sm"`, and segmented ToggleGroups use `spacing={0}` (`apps/editor/src/components/viewport-toolbar.tsx`, `texture-editor.tsx`). Coarse pointers use the `touch` and `touch-icon` sizes. Imported examples must not enlarge the compact desktop defaults ([theming.md](../../reference/architecture/theming.md#density-and-touch)).

## Workflow

1. Check `packages/ui/src/components/` for the primitive. Do not re-add one that exists or import one that does not.
2. Read [components.md](../../reference/components.md) and follow the [editor-ui-components skill](../editor-ui-components/SKILL.md); an editor-kit composite often already does the job.
3. Before using an unfamiliar API, run `npx shadcn@latest docs <component> -c apps/editor`. It prints the Base UI docs, example and API URLs; fetch them rather than relying on memory.
4. To add a primitive, preview it and then add it, from the repository root:

   ```sh
   npx shadcn@latest add <component> -c apps/editor --dry-run
   npx shadcn@latest add <component> -c apps/editor
   ```

   Files are written to `packages/ui/src/components/`. Installed components carry local changes: never pass `--overwrite` without the owner's approval. To pick up an upstream change, compare with `--diff <file>` and merge by hand ([cli.md](cli.md)).
5. Registry items currently import `cn` from the npm package `cn` and list it as a dependency. This repo keeps one `cn` in `packages/ui/src/lib/utils.ts`: change the import to `#lib/utils` and remove any `cn` dependency the CLI added.
6. Read every added file for Base UI props, the `cn` import, lucide icons, groups and titles (rules below). Then record the component as the Rules section of components.md requires.

## Rules

Repository-wide UI standards (semantic and radius tokens only, `flex` with `gap-*`, no raw styled form elements) are in [architecture.md](../../reference/architecture.md#coding-standards). The rules below are specific to composing shadcn primitives.

### Styling: [rules/styling.md](rules/styling.md)

- Use semantic colour utilities, including for status (`text-destructive`, `text-(--warning)`, `text-(--success)`). No raw palette classes and no `dark:` colour overrides.
- Use built-in variants before custom classes. `className` is for layout, not colour or typography.
- Use `size-*` when width equals height and `truncate` for single-line ellipsis.
- Build conditional classes with `cn()`.
- Do not set `z-index` on overlays; Dialog, AlertDialog, Sheet, DropdownMenu, Select and Tooltip stack themselves.

### Forms: [rules/forms.md](rules/forms.md)

- Lay out forms with `FieldGroup` and `Field`; group related checkboxes or switches with `FieldSet` and `FieldLegend`.
- Use `ToggleGroup` for a set of two to seven options, not a loop of Buttons with manual active state.
- Mark invalid fields with `data-invalid` on `Field` and `aria-invalid` on the control, and disabled fields with `data-disabled` on `Field` and `disabled` on the control.

### Composition: [rules/composition.md](rules/composition.md)

- Items sit inside their group: `SelectItem` in `SelectGroup`; `DropdownMenuItem` and `DropdownMenuLabel` in `DropdownMenuGroup`.
- Dialog, AlertDialog and Sheet always have a title; hide it with `className="sr-only"` if needed.
- Use the full Card composition, and put `TabsTrigger` inside `TabsList`.
- Use `Alert`, `Empty`, `Separator`, `Skeleton` and `Badge` instead of custom markup.

### Base UI: [rules/base-ui.md](rules/base-ui.md)

- Replace an element with `render`, adding `nativeButton={false}` when it is not a `<button>`.
- ToggleGroup and Accordion values are arrays; Select reports `null` when cleared.

### Icons: [rules/icons.md](rules/icons.md)

- In a `Button`, mark icons with `data-icon="inline-start"` or `"inline-end"` and add no sizing classes.
- Pass icons as components, not string keys.

## Quick reference

```sh
npx shadcn@latest info -c apps/editor                       # config, resolved paths, installed components
npx shadcn@latest docs select dialog -c apps/editor         # docs, example and API URLs
npx shadcn@latest add tabs -c apps/editor --diff tabs.tsx   # upstream compared with the local file
```

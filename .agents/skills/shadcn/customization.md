# Theme tokens

Edit tokens only in `packages/ui/src/styles/tokens.css`, which `globals.css` imports:

- `:root` holds light values and `.dark` dark values. Keep both as top-level blocks; the docs build re-roots them.
- `@theme inline` maps tokens to utilities (`--color-primary: var(--primary)` gives `bg-primary`). A new colour needs values in `:root` and `.dark`, plus a `@theme inline` entry if it needs a utility; otherwise use `text-(--name)`.

Each `-foreground` token is the text or icon colour on its base surface.

| Variable | Purpose |
| --- | --- |
| `--background` / `--foreground` | App frame and default text |
| `--card` / `--card-foreground` | Card surfaces |
| `--popover` / `--popover-foreground` | Menus, dialogs and floating tools |
| `--primary` / `--primary-foreground` | Primary actions |
| `--secondary` / `--secondary-foreground` | Secondary actions |
| `--muted` / `--muted-foreground` | Muted and disabled states |
| `--accent` / `--accent-foreground` | Hover and selection |
| `--destructive` / `--destructive-foreground` | Errors and destructive actions |
| `--border`, `--input`, `--ring` | Borders, input borders, focus ring |
| `--sidebar`, `--panel-header`, `--control` | PanelFrame, panel headers, inputs |

Values are OKLCH, `oklch(L C H)`: lightness 0–1, chroma (0 is grey), hue 0–360.

`--radius` is `0.5rem`; `@theme inline` multiplies it for `--radius-sm` (0.6), `md` (0.8), `lg` (1), `xl` (1.4) and up to `4xl`. Use radius utilities, never arbitrary radii.

The surface ladder and the pin, node, asset, axis and status tokens: [theming.md](../../reference/architecture/theming.md).

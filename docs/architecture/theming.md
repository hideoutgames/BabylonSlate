# UI theming

Canonical tokens live in [`packages/ui/src/styles/globals.css`](../../packages/ui/src/styles/globals.css). Tailwind v4 maps them via `@theme inline`; components use semantic utilities (`bg-background`, `text-foreground`, `text-vector`, …) — not raw hex in app code.

The editor defaults to dark mode (`<html class="dark">`). A runtime appearance toggle is planned under Engine Settings (`p1-app-settings`).

## Design philosophy

BabylonSlate is a game engine editor: keep chrome quiet and clutter low.

- **No brand accent color.** Primary actions, focus rings, and tab indicators use the text/icon color (`--foreground` / `--primary` aliases of that ink).
- **Avoid decorative highlights.** Prefer borders, weight, and layout over saturated underlines or glow.
- **Saturated colors are type cues**, reserved for small UI (pins, property rows, graph wires) and status — not shell chrome. Add new type tokens as features need them (objects, etc.).

## Base palettes

| Role | Dark | Light |
| --- | --- | --- |
| Background | `#141414` | `#F8F8F8` |
| Secondary background | `#181818` | `#F3F3F3` |
| Borders / edge accents | `#4C4C4C` | `#EEEEEE` |
| Texts and icons | `#F0F0F0` | `#141414` |

Muted text uses derived mid grays (`#A8A8A8` dark, `#6B6B6B` light).

## Action and status tokens

| Role | Token | Notes |
| --- | --- | --- |
| Default actions / ink | `--primary` | Same as text/icon color; inverted `--primary-foreground` for filled buttons |
| Focus / tab indicator | `--ring`, `--chrome-tab-accent`, `--sidebar-ring` | Text/icon color |
| Destructive | `--destructive` (`#A50C19`) | Errors and destructive actions |
| Success | `--success` (`#007041`) | Positive status when needed |

## Type / value colors

| Spec | Hex | Token | Use |
| --- | --- | --- | --- |
| Orange | `#FFAD0A` | `--vector` (`text-vector`, `bg-vector`) | Vector values (and related pins / property cues) |

Further type colors (objects, etc.) land here as those surfaces ship — not as shell accents.

## Surfaces

Secondary background fills `--card`, `--popover`, `--secondary`, `--muted`, `--accent`, `--sidebar`, and `--chrome-tab-active`. Borders map to `--border`, `--input`, and `--sidebar-border`.

Charts (`--chart-1`…`--chart-5`) reuse type/status colors plus neutrals from the border/text ladder.

## Viewport

`packages/render` sets Babylon `scene.clearColor` to the dark background (`#141414`) so the 3D viewport matches the shell.

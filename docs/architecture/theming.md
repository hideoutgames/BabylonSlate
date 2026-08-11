# UI theming

Canonical tokens live in [`packages/ui/src/styles/globals.css`](../../packages/ui/src/styles/globals.css). Tailwind v4 maps them via `@theme inline`; components use semantic utilities (`bg-background`, `text-primary`, `bg-success`, …) — not raw hex in app code.

The editor defaults to dark mode (`<html class="dark">`). A runtime appearance toggle is planned under Engine Settings (`p1-app-settings`).

## Base palettes

| Role | Dark | Light |
| --- | --- | --- |
| Background | `#141414` | `#F8F8F8` |
| Secondary background | `#181818` | `#F3F3F3` |
| Borders / edge accents | `#4C4C4C` | `#EEEEEE` |
| Texts and icons | `#F0F0F0` | `#141414` |

Muted text uses derived mid grays (`#A8A8A8` dark, `#6B6B6B` light).

## Accent mapping

| Spec | Hex | Token |
| --- | --- | --- |
| Orange | `#FFAD0A` | `--primary`, `--ring`, `--sidebar-primary`, `--chrome-tab-accent` |
| Red | `#A50C19` | `--destructive` |
| Green | `#007041` | `--success` (`bg-success`, `text-success`) |

`--primary-foreground` is `#141414` so CTAs stay readable on orange in both modes.

## Surfaces

Secondary background fills `--card`, `--popover`, `--secondary`, `--muted`, `--accent`, `--sidebar`, and `--chrome-tab-active`. Borders map to `--border`, `--input`, and `--sidebar-border`.

Charts (`--chart-1`…`--chart-5`) use orange, green, red, plus two neutrals from the border/text ladder.

## Viewport

`packages/render` sets Babylon `scene.clearColor` to the dark background (`#141414`) so the 3D viewport matches the shell.

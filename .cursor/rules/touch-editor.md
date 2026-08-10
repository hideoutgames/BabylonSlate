# Touch-First Editor Rules

## Touch targets

- Minimum 44pt touch targets on buttons, tabs, graph ports, and Dockview tab headers.
- Use shadcn `Button` with appropriate `size`; avoid dense desktop-only layouts.

## Gestures

- **Dockview**: long-press on tab/header chrome to drag panels. Panel content is a gesture-safe zone.
- **Viewport (Babylon)**: two-finger orbit/pinch on canvas; canvas has `touch-none` for UI chrome separation.
- **Graph (React Flow)**: one-finger pan/zoom inside graph panel only.
- Use long-press for context menus — never assume right-click.

## Mobile platform

- Disable Dockview popout windows and floating groups on iOS/Android.
- Prefer collapsible edge panels over permanent dense sidebars.

## Styling

- Use semantic tokens (`bg-background`, `text-muted-foreground`) — no raw color values.
- Use `flex` + `gap-*` for spacing, not `space-y-*`.

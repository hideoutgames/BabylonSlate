# Editor Density and Touch Support

## Touch targets

- Preserve compact desktop buttons (including Primary buttons), small margins, and tight panel spacing. The editor's complexity makes this density intentional; do not globally enlarge controls or padding to follow imported design guidance.
- Use existing `@babylonslate/ui` Button variants and sizes. Keep keyboard focus, accessible names, and contrast usable at compact sizes.
- For coarse-pointer/touch interaction, provide appropriately sized hit areas (44pt where applicable) or a touch-specific layout without increasing desktop visual defaults. Expanded hit areas must not overlap adjacent controls; use a touch-specific layout when dense controls leave insufficient room.

## Gestures

- **Dockview**: long-press on tab/header chrome to drag panels. Panel content is a gesture-safe zone.
- **Viewport (Babylon)**: one-finger look (3D) or orbit when **Pivot Around Center** is on / marquee (2D), pinch zoom, three-finger pan; canvas has `touch-none` for UI chrome separation.
- **Graph (React Flow)**: one-finger pan/zoom inside graph panel only.
- Use long-press for context menus — never assume right-click.

## Mobile platform

- Disable Dockview popout windows and floating groups on iOS/Android.
- Prefer collapsible edge panels over permanent dense sidebars.

## Styling

- Use semantic tokens (`bg-background`, `text-muted-foreground`) — no raw color values.
- Use `flex` + `gap-*` for spacing, not `space-y-*`.

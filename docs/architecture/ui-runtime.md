# UserInterface runtime (P9)

Shared surface for the widget tree, anchoring/layout, font-stack compilation, and edit-time cycle checks (engineplan §11). Implementation is split like `debugger` so React and Babylon never share a package:

| Layer | Package | Imports |
| --- | --- | --- |
| Widget tree, anchors, layout, font-stack compiler, cycle check | `@babylonslate/ui-runtime` | no React / Babylon / Capacitor |
| Injectable GUI apply, `FontFace` load, sprite quads, shader compile | `@babylonslate/render` | Babylon, no React |
| Designer (design + logic tabs), Font / Sprite editors, graph hosts, Play HUD overlay | `apps/editor` | `@babylonslate/ui`, `editor-kit`, `graph-ui` |

UI mutations travel on the **command channel** ([bridge.md](bridge.md)), not the snapshot. The game worker drives widget properties; the main thread measures text, resolves layout, and applies an injectable GUI host. Worker code never calls `document.fonts`.

v1 Play hosts a **DOM overlay** (`PlayHudOverlay`) so FontFace loads and joystick hit-testing stay on the main thread without mixing React into `@babylonslate/render`. Layout uses `devicePresetForViewport` so iPad Playwright sizes get the matching safe-area insets. The overlay hosts the **active (or first) open viewport-layer UserInterface** when one is open — the same pattern as Play’s open scene — and falls back to `createDefaultPlayHud`. Scanning every UserInterface in the asset registry is later polish. `applyUiControls` still takes an injectable `UiApplyHost` (recorder in tests; Babylon `AdvancedDynamicTexture` remains the long-term mesh/HUD apply target).

## Layout (pure function)

Y-up, origin at the parent’s bottom-left (UMG / Unity RectTransform):

```
left   = parent.x + parent.w * anchorMin.x + offsetMin.x
bottom = parent.y + parent.h * anchorMin.y + offsetMin.y
right  = parent.x + parent.w * anchorMax.x + offsetMax.x
top    = parent.y + parent.h * anchorMax.y + offsetMax.y
```

- Equal `anchorMin` / `anchorMax` **pin**; unequal **stretch**.
- `pivot` is separate from anchors (rotation / alignment origin inside the computed rect).
- Safe-area insets are a first-class parent rect, not a widget flag.
- Design resolution + scale rule: `fitWidth` | `fitHeight` | `shortestSide`.
- Device presets (`ipad-landscape`, `ipad-portrait`, `desktop-16-9`) are data consumed by both the designer and the runtime.

Babylon GUI is top-left: `guiY = parentHeight - rect.y - rect.height`. Layout goldens stay in engine space; the apply step converts.

Text measurement is injected (`TextMeasurer`). Golden tests use a deterministic stub; the live host uses Canvas / `document.fonts` on the main thread.

## Widget payload

A `UserInterface` asset stores the widget tree in the `document` chunk. Nested UserInterface refs are allowed; **edit-time cycle check** rejects a graph that would include itself.

Placement:

- **Viewport layer** — fullscreen HUD on the Play `Scene` (same Engine; textures through the resource cache).
- **WidgetComponent** — world-space 2D prefab (`CreateForMesh`). Component class id already exists; P9 makes it addable and runtime-backed.

`ctx.setWidgetVisible(widgetId, visible)` is a real worker helper: it emits a UI command; render applies it. Scripts never touch Babylon GUI.

## Designer

Dedicated document workspace (not a Dockview Windows menu): **Design** tab (canvas, widget hierarchy `TreeView`, Details `PropertyGrid`, device-preset selector) + **Logic** tab (`GraphEditor` from `graph-ui`, same host as script graphs). Undo via `@babylonslate/edit`. Compose from [components.md](components.md) (`PanelFrame`, `Tabs`, `TreeView`, `PropertyGrid`).

## Touch → P6 input

TouchJoystick / TouchButton / TouchDPad emit `{ kind: "touchAxis", controlId, value }` into the Play ring buffer. Default `Move` bindings include `joystick-x` / `joystick-y` **alongside** gamepad. `GetAxis2D("Move")` is unchanged. Not the editor camera stick (`viewport-joystick.tsx`).

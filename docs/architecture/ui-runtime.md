# UserInterface runtime (P9)

Shared surface for the widget tree, Babylon GUI layout fields, font-stack compilation, and edit-time cycle checks (engineplan §11). Implementation is split like `debugger` so React and Babylon never share a package.

Agents working on this surface — or on **EditorUtilityInterface** (P12), which is also Babylon GUI — must follow [`.cursor/skills/BabylonJS/SKILL.md`](../../.cursor/skills/BabylonJS/SKILL.md) before implementing. Designer chrome around the canvas stays React ([components.md](components.md)); the widget document itself is Babylon GUI.

| Layer | Package | Imports |
| --- | --- | --- |
| Widget tree, layout fields, `previewRect`, font-stack compiler, cycle check | `@babylonslate/ui-runtime` | no React / Babylon / Capacitor |
| Injectable GUI apply, `FontFace` load, sprite quads, shader compile | `@babylonslate/render` | Babylon, no React |
| Designer / Logic chrome (`UiEditorModeBar` + dual DockView catalogs; EUI Settings), Font / Sprite editors, graph hosts, Play HUD host | `apps/editor` | `@babylonslate/ui`, `editor-kit`, `graph-ui` |

UI mutations travel on the **command channel** ([bridge.md](bridge.md)), not the snapshot. The game worker drives widget properties; the main thread applies an injectable GUI host. Worker code never calls `document.fonts`.

v1 Play applies viewport-layer HUD through **`BabylonUiApplyHost`** (`AdvancedDynamicTexture` on the Play scene). Layout fields copy onto nested Babylon controls (no RectTransform solver in the Play path). `devicePresetForViewport` supplies SafeArea insets. The overlay starts **empty**: Play and the exported game do **not** auto-apply a UserInterface. A class graph must call **Apply User Interface** (`ui.applyToViewport`) with an asset guid; the node returns an instance ref. **Remove User Interface** (`ui.removeFromViewport`) takes that ref. The worker emits `uiApply` / `uiRemove`; the host looks up documents from a Play UI library (every UserInterface asset, open documents first). `applyUiControls` takes an injectable `UiApplyHost` (recorder in tests; `BabylonUiApplyHost` in the editor and Play). jsdom Play HUD tests omit the scene and keep pointer handlers on testid markers.

## Layout (Babylon-native)

The document stores the same parameterization Babylon GUI uses (Y-down):

| Field | Babylon |
| --- | --- |
| `horizontalAlignment` / `verticalAlignment` | `left` \| `center` \| `right` / `top` \| `center` \| `bottom` |
| `width` / `height` + `widthUnit` / `heightUnit` | `"160px"` or `"50%"` |
| `left` / `top` | always added after alignment |
| `padding` | `Control.padding*` (stretch insets live here, not on `style.padding`) |
| `transformCenter` | `transformCenterX/Y` in 0–1 |

`style.padding` stays inner/visual. If a widget needs both stretch insets and inner padding, nest: outer control gets layout padding, inner control gets `style.padding`.

- **3×3 + stretch presets** (`applyAnchorPreset`) are macros that write the fields above. They do not store a parallel RectTransform.
- **Safe area:** Canvas hosts a synthetic `__safeArea` container padded by the device preset. Default-add parents into it. `ignoreSafeArea` parents to the full-bleed canvas.
- **Containers:** HorizontalBox/VerticalBox → `StackPanel`; Grid → `Grid` with row/col defs; ScrollBox → `ScrollViewer`. Apply uses `parent.addControl` / `grid.addControl(child, row, col)`. Never `adt.addControl` for non-roots.
- **Scale rule** maps only to ADT `idealWidth` / `idealHeight` / `useSmallestIdeal`. ADT bitmap size is the device/canvas; ideal is `document.designResolution`. There is no `designCanvasRect` letterbox in `layout.ts`.
- **`previewRect`** in `ui-runtime` mirrors Babylon’s published alignment/%/padding formulas for jsdom designer hit-tests. The designer lays out in design space (`designSpace: true`) and maps rects onto the bitmap with origin-aligned scale; when a live Engine exists it prefers ADT measured bounds. Play apply copies layout fields onto controls and does not feed canvas-mapped `guiRect`s as the source of truth. jsdom Play HUD markers still use origin-aligned mapped rects for pointer tests.
- Legacy `anchorMin/Max` + `offsetMin/Max` payloads migrate via `migrateUserInterfacePayload` (UserInterface schema v2). `normalizeUserInterfaceDocument` (used by `asUiDocument`) always produces a Canvas root plus layout/style/props/children, so a missing widget never throws on `widgets[id]!`.

Device presets: built-ins (`desktop-4-3` 1600×1200, `desktop-16-9` 1920×1080, `desktop-21-9` 2560×1080 Widescreen) plus designer **Desired** (`desired` canvas id). All built-ins use zero Safe Area. Desired has no Width/Height fields: the frame is `contentDesiredSize` (AABB of canvas children from the origin; empty documents keep `DEFAULT_DESIRED_SIZE` 400×300). Custom sizes live in Engine Settings `uiDesignerPresets` and merge after the built-ins (`mergeDevicePresets`); reserved ids (`desired` and built-in ids) cannot be overridden. The designer dropdown and Play overlay (`devicePresetForViewport`) both consume the merged list so a custom 390×844 row can supply matching safe-area insets. Switching a designer preset does not rewrite the widget tree — percent/stretch widgets reflow on the new bitmap; Play still scales via `designResolution` + `scaleRule` and picks Safe Area from the closest preset to the overlay size.

Text measurement is injected (`TextMeasurer`). Golden tests use a deterministic stub; the live host uses Canvas / `document.fonts` on the main thread.

## Widget payload

A `UserInterface` asset stores the widget tree in the `document` chunk. Nested UserInterface widgets (`kind: "UserInterface"`, `nestedUiGuid`) are allowed; **edit-time cycle check** (`nestedUiPickableGuids`) excludes self and cycle partners from the designer picker. `visualOverrideGuid` on Button / TouchJoystick / TouchButton is the same nested-subtree path.

Placement:

- **Viewport layer** — applied at runtime by `ctx.applyUserInterface(assetGuid)` (instance ids `ui-1`, `ui-2`, …). Not auto-hosted on Play.
- **WidgetComponent** — world-space 2D prefab (`CreateForMesh`). Class id exists; Add Component and Search hide it until a runtime `CreateForMesh` path exists. Viewport-layer HUD is the v1 Play path.

`ctx.setWidgetVisible(widgetId, visible)`, `ctx.applyUserInterface(assetGuid)`, and `ctx.removeUserInterface(instanceId)` are real worker helpers: they emit UI commands; the Play overlay applies them. Scripts never touch Babylon GUI.

## Designer / Logic

Chrome **Designer | Logic** `ToggleGroup` (`UiEditorModeBar`; testids `ui-editor-mode-bar`, `ui-editor-mode-designer`, `ui-editor-mode-logic`) sits **outside** DockView. Below it, two stacked DockView surfaces persist separately (`layout.json` `{ uiEditorMode, designer, logic }`; raw old snapshots migrate to Designer). **Windows** and Focus follow the **active mode**. Leftover `ui-logic` panels close on restore. Designer canvases freeze while Logic is open (`documentActive` requires designer mode). This mode bar is the documented exception to “all document chrome is DockView” ([dockview-editor-tabs.mdc](../../.cursor/rules/dockview-editor-tabs.mdc)).

EditorUtilityInterface authoring is the same shell plus **Settings** (`dockKind: "scene" | "class"`) on the Designer catalog. Live-run of an EUI stays **Windows → Editor Utilities** ([editor-extensions.md](editor-extensions.md)). Play compiles `payload.logic` with Class graphs. Default UI Logic `parentClass` is BObject. Built-in canvases are read-only. If the selected custom id is deleted, the designer falls back to `desktop-16-9`. Undo via `@babylonslate/edit`. Compose from [components.md](components.md) (`PanelFrame`, `TreeView`, `NestedMenu`, `PropertyGrid`, `AssetPicker`, `CatalogDialog`, `NamePromptDialog`, `GraphEditor`, `ToggleGroup`).

| Mode | Windows catalog | Primary panel |
| --- | --- | --- |
| **Designer** | Design, Hierarchy, Details (EUI adds Settings). Not Graph/Class. | `ui-design` |
| **Logic** | Same as BObject Class: Graph, Class, Inspector, Compiler Results. Graph is `payload.logic`. | `graph` |

- **Design canvas** (`ui-design-viewport` / `ui-design-canvas`): `touch-none` wrapper. Game widgets paint through `BabylonUiApplyHost` on a design-space standalone `CreateFullscreenUI` on the shared app Engine (`isHitTestVisible = false`). The ADT’s Canvas2D backing store is copied onto the document canvas — **not** `registerView`, which would blit the last 3D framebuffer onto the tab. `presentAdtToCanvas` throws if the 2D context or ADT backing store is missing (hard failure → **Babylon GUI Preview Unavailable**); a 0×0 ADT size is skipped so a hidden or unmeasured panel does not empty the canvas. Hidden Design tabs call `UiSurface.setFrozen(true)` so ADT copies from `present`, `markDirty`, and pointer picks skip (`freezeLiveUiSurface` / `blitIfUnfrozen`), and `applyUiControlsIfUnfrozen` skips control rebuilds. Close disposes the Scene + ADTs. The device frame uses a muted/background checkerboard so a failed blit is not mistaken for an authored black Canvas. Transparent hit rects keep `data-testid={`ui-widget-${id}`}` for jsdom / Playwright. A second **screen-space** standalone ADT paints selection, 44px resize handles (skipped for the Canvas root and box/grid/SizeBox children), transform-center, and safe-area guides so handles stay 44 CSS px under pan/zoom; DOM hit targets remain for pointers and testids. jsdom (no Engine) uses `previewRect` mapped onto the device bitmap; a live Engine prefers ADT measured bounds. Tap selects; drag after a 4px threshold previews `left`/`top` locally and commits **once on pointer-up** (one undo). Handle drag resizes the same way. Empty canvas / root selects the Canvas and one-finger pans. Two fingers pan; pinch span also zooms; wheel zooms around the pointer; **Fit** recenters. Apply **reconciles** unchanged Babylon controls instead of clearing the ADT. Resize/present is rAF-coalesced (`createUiFrameScheduler`). Drag still commits **once on pointer-up**; `uiHostStats.commit` counts those commits. Test-mode `window.__babylonslateUiHostStats` exposes `apply` / `create` / `present` / `commit`.
- **Per-project UI/font library cache:** designers share one UserInterface + Font library load per project (`rememberProjectUiAssets`). Close or switch project resets it so identical paths (`assets/HUD.ui.babasset`) cannot reuse another project's documents.
- **Add Widget** is a `CatalogDialog` (Containers / Controls / Touch). New widgets use `defaultAddLayout` (center align + preferred px size), not stretch-fill, unless the parent is a box/grid/SizeBox slot. **New Asset → UserInterface** seeds `createDefaultUserInterface` (Canvas root only). `createDefaultPlayHud` (title + joystick) is a test fixture, not the create path.
- **Hierarchy** is a collapsible `TreeView`: collapse, immediate drag-to-reparent (cycle/root rejected). Trailing ⋯ `NestedMenu`: **Visible**, **Ignore Safe Area** (Canvas children), Duplicate / Rename / Delete. Rows do not open a long-press menu. The Canvas root cannot be duplicated or deleted. `duplicateWidget` copies descendants.
- **Details** expose identity and kind props plus **AnchorPresetPicker** (macros) and Alignment / Left / Top / Width / Height (px or %) / layout Padding. Advanced is transform center. Canvas children can **Ignore Safe Area**. Box/Grid children show that the parent slot owns layout.
- **Desired** sizes the authoring frame to `contentDesiredSize` (content AABB). Nested layout uses that same size as the nested document’s design resolution inside the host slot. The payload may still store `desiredSize` for compatibility; the designer does not edit it.
- Unspecified Text / Button / InputText `style.color` applies as `#ffffff` (Babylon’s empty color would `fillText` with the canvas default black). TouchJoystick without a background uses `#e5e5e5`, not `#000000`. Canvas Rectangle background stays authored — no implicit fill.
- **Nested UserInterface** is a widget kind. The Details asset picker lists other UserInterface assets and omits the document under edit and any guid that would close a cycle. Visual-override picks use the same cycle filter.

## Touch → P6 input

TouchJoystick / TouchButton / TouchDPad emit `{ kind: "touchAxis", controlId, value }` into the Play ring buffer. Default `Move` bindings include `joystick-x` / `joystick-y` **alongside** gamepad. `GetAxis2D("Move")` is unchanged. Not the editor camera stick (`viewport-joystick.tsx`). TouchDPad is a `Rectangle` with composed `Ellipse`s; TouchButton is a `Rectangle`. Slider `props.min` / `props.max` copy onto the Babylon slider. Play does not show a stick until a HUD is applied; an unlabeled TouchJoystick reads as **Stick**.

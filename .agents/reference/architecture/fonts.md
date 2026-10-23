# Fonts

Font assets, optional facetype/MSDF chunks, CSS fallback stacks and the main-thread `FontFace` registry used by 3D Text and overlay 2D Text.

## Ownership

| Area | Source |
| --- | --- |
| Importer, chunk ids | [`packages/assets/src/importers/font.ts`](../../../packages/assets/src/importers/font.ts) |
| CSS stacks (`compileFontStack`, `compileText2DFontStacks`) — pure | [`packages/assets/src/font-stack.ts`](../../../packages/assets/src/font-stack.ts) |
| `FontRegistry` (main thread only, `document.fonts`) | [`packages/render/src/font-registry.ts`](../../../packages/render/src/font-registry.ts) |
| 3D Text mesh (`createText3DMesh`) | [`packages/render/src/text3d-mesh.ts`](../../../packages/render/src/text3d-mesh.ts) |
| Overlay 2D Text glyph meshes | [`packages/render/src/text2d-mesh.ts`](../../../packages/render/src/text2d-mesh.ts) |
| Export sidecar prefixes | [`packages/exporter/src/constants.ts`](../../../packages/exporter/src/constants.ts) |
| Project font settings (`fonts.defaultFontGuid`, `fonts.globalFallback`) | [`packages/core/src/project.ts`](../../../packages/core/src/project.ts) |

## Asset format

- Imported from woff2 / woff / ttf / otf; New Asset never creates Fonts. A Font can also be created from representation files alone (MSDF JSON + PNG or facetype JSON) and then has no `source` chunk.
- Payload: `family`, `weight`, `style` (`normal` | `italic`), ordered `fallbackGuids`, `representations` flags (`source`, `facetype`, `msdfJson`, `msdfPng`, `msdf` true only when both MSDF parts exist).
- Optional chunks are import-only, never baked in-engine: `facetype-glyphs` (`FONT_FACETYPE_CHUNK_ID`), `msdf-atlas` (JSON), `msdf-atlas-png` (PNG). The MSDF PNG is a Font companion, not a Texture asset.
- Imported Fonts store their payload on the `.hasset` header (no `document` chunk); `decodeAssetDocument` falls back to `header.payload`. Saving keeps the extra chunks beside the rewritten body.
- Attaching MSDF merges representation flags with OR (never clears `source`) and writes both the header and any saved `document` chunk; an open Font tab merges only those flags into its payload.
- Export packs `font-facetype:<guid>`, `font-msdf:<guid>` and `font-msdf-png:<guid>` sidecars so the source Font stays a font file. A player missing the MSDF sidecar falls back to Bitmap (log once).

## Fallback stack

`compileFontStack` order: asset family → `fallbackGuids` families → project default font → global generic (`sans-serif` unless overridden).

- Duplicates drop. Families are always quoted, so a Font named `serif` still names its own face.
- The stack always ends in a generic family so a failed load is never a silent Arial.
- `compileText2DFontStacks` gives editor viewport, Play and player a project default stack plus a per-Font map (`fontCssStack` / `fontCssStackByGuid`). Play compiles them from every project Font in each source acquisition (`playText2DFontStacks` in `play-asset-sources.ts`), because engine source unions keep the last acquisition's `fontCssStack`; the player compiles them from the manifest's Fonts.
- A stack that leaves out the Font draws the generic face without any error, so all three hosts must compile stacks the same way.

## FontRegistry rules

- Injectable `FontFaceHost` so Node tests mock `FontFace` and `document.fonts`.
- `register` awaits that face's own `FontFace.load()`; a family-wide `document.fonts.load` would only cover the regular face.
- One document face per registered content (family, weight, style and a byte fingerprint). Changed bytes replace the face only after the new one loads; a failed load is removed and recorded in `getWarnings()`, never silently substituted.
- Late resolution sets `consumeDirty()` so hosts can mark the render scheduler dirty. That only redraws: it never re-rasterizes Bitmap 2D Text already built.
- `dispose()` removes only that registry's faces. Engine dispose, construction rollback and the Font document preview dispose their registries.

## Cold load

Bitmap 2D Text measures and rasterizes its glyphs once, when its mesh is built, so a face must be loaded before that build.

- Editor viewports await `registerFonts` before `setMeshAssets`.
- Play and the player install a command source loader before the game worker starts. `CommandSourcePreparation` holds every text `assignMesh` (an empty Font guid means the project default) until `acquireSceneSources` has registered the slot's faces through the Engine's native preparation queue. A face that fails to load rejects the slot with the registry's reason (`Font "<family>" failed to load: …`), and Scene or Scene Layer readiness reports `Scene loading failed` (Play: the session ends and its report lists the error; player: diagnostic, `[player]` console error, playback halts).
- `createEngine({ fontFaceEntries })` also registers the startup faces and world readiness awaits them, but its failures stay registry warnings; the per-slot gate is what fails loudly.
- Proof (`e2e/p14-preview-build.spec.ts`): on a cold load, Play and Preview Build lay out explicit- and default-Font text with the Font's own advances, read as each Text mesh's laid-out width (`EngineHandle.playText2DLayouts`, the test hosts' `text2dLayouts`) and compared, as equal-length digit runs, with an independently loaded copy of the Font. A Font that cannot load ends Play with the error in its session report.
- Gaps: Play and player FontFace entries carry no weight or style (every face registers as 400 normal); the export manifest carries no Global Fallback, so the player always ends stacks in `sans-serif`.

## 3D Text

- `Text3DComponent` is a flat triangulated TypeFace mesh (`CreateTextShapePaths` + `CreatePolygon` + injected `earcut`), one unlit two-sided material. It is a scene mesh, not a DynamicTexture plane, and not Development Only.
- Uses the Font's `facetype-glyphs` chunk when it parses, else the bundled ASCII TypeFace (5×7 pixels greedy-merged). Play/export collect those bytes independently of `FontFace` source bytes.
- Newlines stack upward from a bottom origin; `alignment` is the horizontal anchor, not a wrap width.

## Overlay 2D Text

- Renderer `bitmap` (default): canvas `FontFace` glyphs packed onto a shared RGBA atlas when the paint is letter-shaped; blank or solid tofu output (Node, NullEngine, broken headless 2D) falls back to the bundled 5×7 bitmap.
- Renderer `msdf` is enabled only when the Font has both JSON and PNG; the Inspector writes `renderer` back to `bitmap` if the pair becomes incomplete. Missing atlas glyphs fall back to Bitmap cells.
- MSDF import paths (Content Browser Import, Font document, tile context menu) all use the platform picker (`pickImportFiles`).

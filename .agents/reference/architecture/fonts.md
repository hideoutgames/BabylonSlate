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
- Imported Fonts store their payload on the `.babasset` header (no `document` chunk); `decodeAssetDocument` falls back to `header.payload`. Saving keeps the extra chunks beside the rewritten body.
- Attaching MSDF merges representation flags with OR (never clears `source`) and writes both the header and any saved `document` chunk; an open Font tab merges only those flags into its payload.
- Export packs `font-facetype:<guid>`, `font-msdf:<guid>` and `font-msdf-png:<guid>` sidecars so the source Font stays a font file. A player missing the MSDF sidecar falls back to Bitmap (log once).

## Fallback stack

`compileFontStack` order: asset family → `fallbackGuids` families → project default font → global generic (`sans-serif` unless overridden).

- Duplicates drop. Families are always quoted, so a Font named `serif` still names its own face.
- The stack always ends in a generic family so a failed load is never a silent Arial.
- `compileText2DFontStacks` gives editor viewport, Play and player a project default stack plus a per-Font map (`fontCssStack` / `fontCssStackByGuid`).

## FontRegistry rules

- Injectable `FontFaceHost` so Node tests mock `FontFace` and `document.fonts`.
- `register` awaits that face's own `FontFace.load()`; a family-wide `document.fonts.load` would only cover the regular face.
- One document face per registered content (family, weight, style and a byte fingerprint). Changed bytes replace the face only after the new one loads; failed loads warn in the editor and are removed — never silently substituted.
- Late resolution sets `consumeDirty()` so hosts can mark the render scheduler dirty. `createEngine({ fontFaceEntries })` registers at construction.
- `dispose()` removes only that registry's faces. Engine dispose, construction rollback and the Font document preview dispose their registries.
- Editor viewports await `registerFonts` before `setMeshAssets` so Bitmap 2D Text rasterizes loaded faces.

## 3D Text

- `Text3DComponent` is a flat triangulated TypeFace mesh (`CreateTextShapePaths` + `CreatePolygon` + injected `earcut`), one unlit two-sided material. It is a scene mesh, not a DynamicTexture plane, and not Development Only.
- Uses the Font's `facetype-glyphs` chunk when it parses, else the bundled ASCII TypeFace (5×7 pixels greedy-merged). Play/export collect those bytes independently of `FontFace` source bytes.
- Newlines stack upward from a bottom origin; `alignment` is the horizontal anchor, not a wrap width.

## Overlay 2D Text

- Renderer `bitmap` (default): canvas `FontFace` glyphs packed onto a shared RGBA atlas when the paint is letter-shaped; blank or solid tofu output (Node, NullEngine, broken headless 2D) falls back to the bundled 5×7 bitmap.
- Renderer `msdf` is enabled only when the Font has both JSON and PNG; Details writes `renderer` back to `bitmap` if the pair becomes incomplete. Missing atlas glyphs fall back to Bitmap cells.
- MSDF import paths (Content Browser Import, Font document, tile context menu) all use the platform picker (`pickImportFiles`).

# Fonts (P9)

Font assets, fallback stacks, and the main-thread `FontFace` registry (engineplan §11.4). CSS-stack compilation lives in `@babylonslate/assets` (pure). `FontFace` load lives in `@babylonslate/render` because `document.fonts` is main-thread only.

## Asset

Importer (`packages/assets/src/importers/font.ts`) already accepts woff2 / woff / ttf / otf plus optional facetype / MSDF JSON **attach** chunks. Payload fields:

| Field | Role |
| --- | --- |
| `family` | CSS family name registered with `FontFace` |
| `weight` | numeric or keyword (`400`, `bold`) |
| `style` | `normal` \| `italic` |
| `fallbackGuids` | ordered Font asset guids |
| `representations` | flags: `source`, `facetype`, `msdfJson`, `msdfPng`, and `msdf` (true only when **both** JSON and PNG exist) |

Facetype and MSDF remain **import-only** optional chunks (no in-engine bake). Chunk ids: `facetype-glyphs` (`FONT_FACETYPE_CHUNK_ID`); `msdf-atlas` (`FONT_MSDF_CHUNK_ID`, JSON); `msdf-atlas-png` (`FONT_MSDF_PNG_CHUNK_ID`, PNG). An MSDF PNG is a Font companion, not a Texture.

## 3D Text

`Text3DComponent` (catalog **3D Text**) builds a flat triangulated TypeFace mesh in `@babylonslate/render` (`createText3DMesh`: `CreateTextShapePaths` + `CreatePolygon` + injected `earcut`). One unlit two-sided material. This is a scene mesh, not a DynamicTexture plane. Bundled ASCII glyphs greedy-merge 5×7 pixels into rectangles. Serialized `depth` is ignored. Newlines (`\n`; CRLF normalized) stack extra lines **up** from a bottom origin. `alignment` (`left` default, `center`, `right`) is the horizontal anchor of the block, not a wrap-width.

| Font data | When |
| --- | --- |
| Font `facetype-glyphs` bytes | `fontAssetGuid` set and the chunk parses |
| Bundled ASCII TypeFace | No Font, missing chunk, or invalid JSON |

Details shows a disabled **Typeface** note when the Font has no facetype chunk. Play/export collect those bytes independently of `FontFace` source bytes. Export packs a `FontFacetype` sidecar (`font-facetype:<guid>`) so the source Font stays a font file. The component is **not** Development Only.

See [render.md](render.md) and [engineplan §11.4](../engineplan.md).

## Overlay 2D Text (optional MSDF)

`2DTextComponent` / `2DRichTextComponent` default to **Bitmap**. Each non-whitespace glyph is rasterized (canvas `fillText` after `FontFace` load when the alpha is letter-shaped, else the bundled 5×7) and packed onto a shared RGBA atlas; letter quads sample that atlas and are sized to the raster cell. A solid tofu box (glyph-sized rectangle with padding) is not treated as a letter. **MSDF** is enabled in Details only when the Font has both JSON and PNG. Three equivalent import paths, all using the platform picker (`pickImportFiles`, multi-select `.json,.png`):

1. Content Browser **Import** — JSON + PNG together create a Font when the family is new, or attach to an existing Font.
2. Font document **Import MSDF Atlas…** (`data-testid="font-import-msdf"`) — always attaches to the open Font.
3. Font tile context menu **Import MSDF Atlas…**.

Incomplete picks leave `representations.msdf` false until the pair is complete. Attach merges representation flags with OR so attaching MSDF does not clear `source`. Export packs `FontMsdf` (`font-msdf:<guid>`) and `FontMsdfAtlas` (`font-msdf-png:<guid>`) when the Font is in the closure and both chunks exist. A packed game missing the sidecar falls back to Bitmap (log once).

## Fallback stack

`compileFontStack` in `@babylonslate/assets` builds a quoted CSS stack:

1. The asset family.
2. Ordered fallback families from `fallbackGuids`.
3. Project default font (Project Settings).
4. Global generic fallback (`sans-serif` unless overridden).

Duplicates are dropped. The stack always terminates in a generic family so a failed load is never silent Arial. `compileText2DFontStacks` builds the project default stack plus a per-Font map; editor viewport / Play / player pass those as `fontCssStack` / `fontCssStackByGuid`.

Project Settings (`packages/core` `ProjectSettings.fonts`): `defaultFontGuid`, `globalFallback` (generic CSS family).

## Registry (`render`)

`FontRegistry` takes an injectable `FontFaceHost` so Node tests mock `document.fonts`:

1. `new FontFace(family, bytes)` + `document.fonts.add`.
2. **Await** `document.fonts.load` before the first 3D Text / Font sample paint (`register` / `registerAll`).
3. Late resolve → `consumeDirty()` so a host can `markAsDirty()`.
4. Failed load → editor warning, never a silent substitution.

The Font document workspace calls `register` when the asset has a `source` chunk (imported woff/ttf/otf). New Asset fonts have payload only — the sample still compiles a CSS stack that terminates in the Project Settings generic fallback. Editor viewports **await** `registerFonts` before `setMeshAssets` so Bitmap 2D Text rasterize sees loaded faces. Imported fonts store payload on the babasset **header** (no `document` chunk); `decodeAssetDocument` falls back to `header.payload` so they open. Saving a Font keeps extra chunks (`source`, facetype, msdf) beside the rewritten document body.

## Editor

Font document workspace: sample text that flags glyphs whose advance matches the generic-only stack (fall-through). The sample uses `compileFontStack` with per-asset `fallbackGuids`, the Project Settings default font family, and `globalFallback`. Fallback guids are a `NamedListEditor` of Font `AssetPicker` rows (not typed guids; closed buttons show icon, name, and **Font**). Project Settings → **Fonts** category: Default Font is an `AssetPicker` with the same identity row; Global Fallback is a `Select` of generic families (`sans-serif`, `serif`, `monospace`, `system-ui`).

Playwright: Font editor sample preview (`data-fonts-ready`, compiled stack). Registry-ready is asserted in unit tests with a mock host; an imported font’s source bytes are registered before the sample paints.

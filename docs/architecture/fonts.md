# Fonts (P9)

Font assets, fallback stacks, and the main-thread `FontFace` registry (engineplan §11.4). Layout and CSS-stack compilation live in `@babylonslate/ui-runtime` (pure). `FontFace` load lives in `@babylonslate/render` because `document.fonts` is main-thread only.

## Asset

Importer (`packages/assets/src/importers/font.ts`) already accepts woff2 / woff / ttf / otf plus optional facetype / MSDF JSON **attach** chunks. Payload fields:

| Field | Role |
| --- | --- |
| `family` | CSS family name registered with `FontFace` |
| `weight` | numeric or keyword (`400`, `bold`) |
| `style` | `normal` \| `italic` |
| `fallbackGuids` | ordered Font asset guids |
| `representations` | flags for source / facetype / msdf chunks present |

Facetype and MSDF remain **import-only** optional chunks (no in-engine bake).

## Fallback stack

`compileFontStack` in `ui-runtime` builds a quoted CSS stack:

1. The asset family.
2. Ordered fallback families from `fallbackGuids`.
3. Project default font (Project Settings).
4. Global generic fallback (`sans-serif` unless overridden).

Duplicates are dropped. The stack always terminates in a generic family so a failed load is never silent Arial.

Project Settings (`packages/core` `ProjectSettings.fonts`): `defaultFontGuid`, `globalFallback` (generic CSS family).

## Registry (`render`)

`FontRegistry` takes an injectable `FontFaceHost` so Node tests mock `document.fonts`:

1. `new FontFace(family, bytes)` + `document.fonts.add`.
2. **Await** `document.fonts.load` before the first UI draw (`register` / `registerAll`).
3. Late resolve → `consumeDirty()` so a host can `markAsDirty()`.
4. Failed load → editor warning, never a silent substitution.

The Font document workspace calls `register` when the asset has a `source` chunk (imported woff/ttf/otf). New Asset fonts have payload only — the sample still compiles a CSS stack that terminates in the Project Settings generic fallback. Imported fonts store payload on the babasset **header** (no `document` chunk); `decodeAssetDocument` falls back to `header.payload` so they open. Saving a Font keeps extra chunks (`source`, facetype, msdf) beside the rewritten document body.

Play HUD and the UserInterface designer both `FontRegistry.registerAll` project Font `source` bytes, then `consumeDirty()` → ADT `markAsDirty()` so a late face still redraws.

## Editor

Font document workspace: sample text that flags glyphs whose advance matches the generic-only stack (fall-through). The sample uses `compileFontStack` with per-asset `fallbackGuids`, the Project Settings default font family, and `globalFallback`. Fallback guids are a `NamedListEditor` of Font `AssetPicker` rows (not typed guids). Project Settings → **Fonts** category: Default Font is an `AssetPicker`; Global Fallback is a `Select` of generic families (`sans-serif`, `serif`, `monospace`, `system-ui`).

Playwright: Font editor sample preview (`data-fonts-ready`, compiled stack). Registry-ready is asserted in unit tests with a mock host; an imported font’s source bytes are registered before the sample paints.

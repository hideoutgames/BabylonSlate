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
2. **Await** `document.fonts.load` before the first UI draw.
3. Late resolve → `consumeDirty()` so the Play HUD / designer can `markAsDirty()`.
4. Failed load → editor warning, never a silent substitution.

## Editor

Font document workspace: sample text that flags glyphs whose advance matches the generic-only stack (fall-through). Project Settings → **Fonts** category for default font + global fallback.

Playwright: Font editor sample preview; registry-ready is asserted in unit tests with a mock host. Cold-load “custom font on first frame” is the registry await contract plus the UserInterface Play path.

# Sprites

Sprite and Sprite Animation assets and `SpriteComponent`, rendered as UV-baked quad meshes.

## Decisions

- `SpriteComponent` is a quad **mesh**, not `BABYLON.Sprite`, because a Babylon Sprite is not a Mesh: it cannot parent, take a shader, hold a physics shape or share the gizmo path.
- Thin instances and merged static batching are out of scope until measured.
- Sprites default to alpha **test** (opaque pass). `alphaIndex` from [`sorting.ts`](../../../packages/render/src/sorting.ts) orders draws and does not opt into blending. A fractional `visibility` switches the owned material to test + blend; only an `alwaysBlend` binding uses plain blend. Changing the default to blend needs an on-device fill-rate measurement first.
- Sampling is pixel-art: NEAREST, no mips, anisotropy 1, through a dedicated `ResourceCache` sampling wrapper (`PIXEL_ART_TEXTURE_SAMPLING`) so a mipped 3D load of the same texture cannot bleed. Sprite textures stay uncompressed.
- A Sprite is one whole Texture: no frames, clips or atlas sub-rects. Moving images are Sprite Animation assets (Texture or Sprite frames, or the cells of one sheet Texture). Sprites are made with New Asset; there is no atlas-JSON or loose-frame importer.
- A Sprite frame references its Sprite instead of copying it, so the Sprite stays the one place its pivot and collision are edited.

## Ownership

| Area | Source |
| --- | --- |
| Sprite payload (`parseSpritePayload`, `applyTexturePixelSizeToSprite`, `spriteWorldSize`), `spriteCollisionToBox2d` | [`packages/assets/src/sprite-payload.ts`](../../../packages/assets/src/sprite-payload.ts) |
| Sprite Animation payload, `resolveSpriteAnimation`, `hydrateSpriteAnimations`, sheet grid helpers | [`packages/assets/src/sprite-animation-payload.ts`](../../../packages/assets/src/sprite-animation-payload.ts) |
| Quad builder (`createSpriteQuad`, `setSpriteQuadSize`, `setSpriteQuadUvs`) | [`packages/render/src/sprite-quad.ts`](../../../packages/render/src/sprite-quad.ts) |
| Animation frame apply (`applySpriteAnimationAssetFrame`) | [`packages/render/src/anim-apply.ts`](../../../packages/render/src/anim-apply.ts) |
| Editor resolve and preload (`useResolvedSpriteAnimation`, `useTexturePreviews`) | [`sprite-animation-sources.ts`](../../../apps/editor/src/components/sprite-animation-sources.ts), [`texture-preview-status.tsx`](../../../apps/editor/src/components/texture-preview-status.tsx) |
| Pixel-art sampling wrapper | [`packages/render/src/resource-cache.ts`](../../../packages/render/src/resource-cache.ts) |
| Albedo binding and alpha mode (`applyAlbedoTexture`) | [`packages/render/src/mesh-assets.ts`](../../../packages/render/src/mesh-assets.ts) |
| Box2D collider sync (`SpriteTileColliders`) | [`packages/runtime/src/physics-sprite-tile-colliders.ts`](../../../packages/runtime/src/physics-sprite-tile-colliders.ts) |

## Sprite asset

| Field | Role |
| --- | --- |
| `textureGuid` | The Texture, shown whole (full UVs) |
| `pixelsPerUnit` | Default 100 |
| `pivot` | Normalized point on the actor origin, v down |
| `collision` | Normalized AABB, default `{0,0,1,1}` |
| `width` / `height` | Never authored: loaders set them from the Texture's size (`applyTexturePixelSizeToSprite`), so a re-imported Texture resizes the Sprite. Play, the viewports and thumbnails read Texture headers (`playSpritePayloadsFromGuids`); the player reads catalog sizes, then source bytes (`hydrateSpritePixelSizes`). Unknown sizes fall back to 100 px (`DEFAULT_SPRITE_PIXEL_SIZE`) |

The quad is `width` / `height` over `pixelsPerUnit` (`spriteWorldSize`), offset so the pivot sits on the actor origin, which is where `spriteCollisionToBox2d` centers the box collider.

## Sprite Animation asset

- Separate `.spriteanim.hasset` in the Content Browser Animation group. Payload: `frameDurationMs` (default 100), `source` (`frames` | `sheet`), `sheet` `{ textureGuid, cellWidth, cellHeight, margin, spacing }` (default 32 px cells; kept while `source` is `frames` so switching back restores it) and `frames[]` of `{ textureGuid, spriteGuid?, cell?, durationMsOverride?, durationMs, pivot, collision, width?, height?, uv? }`.
- `frames` source: a frame shows `spriteGuid` (that Sprite's Texture, pivot and collision) or else `textureGuid` (whole Texture, its own pivot and collision). `sheet` source: every frame shows its 1-based `cell` of `sheet.textureGuid`, counted row by row from the top-left; the grid is a Tileset grid (`spriteAnimationSheetGrid`), so cell rects and inset UVs match Tilesets.
- `resolveSpriteAnimation(payload, { sprite, textureSize })` turns authored frames into what renderers and physics read: Sprite frames take the Sprite's `textureGuid`, `pivot`, `collision` and Texture size; sheet cells take the sheet Texture, the cell size and `uv` (GL, v up; absent outside the Texture); Texture frames take the Texture size. Known sizes replace stored `width` / `height`. Frames whose Sprite is missing keep their fields.
- Play and the player resolve in the exporter hydrate (`hydrateSpriteAnimations`): Sprites from the sized Sprite payloads, Texture sizes from the catalog, else source bytes. The editor resolves for its preview from Texture headers and Sprite documents (open tabs first).
- Effective duration = sum of per-frame durations (`durationMs` when `durationMsOverride` is true, else `frameDurationMs`).
- Header `dependencies[]` (`spriteAnimationDependencyGuids`) lists the frame Textures (or the sheet Texture) and the frame Sprites for Show References and the export closure; `atlasTextures` lists only Textures sampled directly (a Sprite lists its own).
- Content Browser **Create Sprite Animation** (any Textures and Sprites, no folders) writes one frame per asset in natural name order beside the first, named `spriteAnimationNameFor(first)`; **Create Sprite** writes one Sprite per Texture; **Create Tileset** (one Texture) writes a Tileset with the Texture's name and header size. See [Create from assets](asset-registry.md#create-from-assets).
- Animation Graph and Behaviour Tree **Sprite** clips pick Sprite Animation assets. A Sprite clip whose guid names no loaded Sprite Animation is reported once as a missing clip (`onceMissingClip`); the quad keeps what it showed and a blend overlay hides.

## Runtime and render

- Play loads sprite payloads from scene `SpriteComponent.assetGuid` (the asset need not be open). Play `assignMesh` with `meshKind: "sprite"` builds the same quad as the editor.
- For a Sprite Animation clip, `applySpriteAnimationAssetFrame` binds the resolved frame's Texture, sets the quad UVs to the cell's `uv` (or the whole Texture), resizes the quad from pixels / `pixelsPerUnit` and re-offsets the pivot.
- With a `box2d` `ColliderComponent`, `PhysicsWorldSync` maps the current frame's collision AABB through `spriteCollisionToBox2d` every tick while a Sprite Animation plays. Leaving a sprite clip clears the override. Circle / capsule / polygon colliders stay as authored.
- Trace frames record each actor's Sprite Animation clip; restore reapplies it (or clears it).
- 2D projection golden: a sprite at world +X renders right of origin (left-handed, camera at −Z).

## Editor

- Sprite and Sprite Animation documents are DockView shells (Preview + Inspector), composed from catalog components. The Texture picker shows the asset identity (icon, name, type), never a raw guid.
- The Sprite Preview shows the whole Texture on a checkerboard with the pivot crosshair and a draggable collision AABB overlay. The Inspector has Texture, Pixels Per Unit, Pivot and Collision.
- The Sprite Animation Preview loads and decodes every frame Texture once (`useTexturePreviews`) so playback swaps images without a load state, crops sheet cells from the sheet image, and shows a Sprite frame's collision read-only. Its **Sheet** view reuses `AtlasTileGrid` on the sheet grid: a tap sets the selected frame's cell, a drag makes the covered cells the frames. The Inspector shows a Sprite frame's Pivot and Collision disabled, with **Open Sprite**.

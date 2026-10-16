# Sprites

Sprite and Sprite Animation assets and `SpriteComponent`, rendered as UV-baked quad meshes.

## Decisions

- `SpriteComponent` is a quad **mesh**, not `BABYLON.Sprite`, because a Babylon Sprite is not a Mesh: it cannot parent, take a shader, hold a physics shape or share the gizmo path.
- Thin instances and merged static batching are out of scope until measured.
- Sprites default to alpha **test** (opaque pass). `alphaIndex` from [`sorting.ts`](../../../packages/render/src/sorting.ts) orders draws and does not opt into blending. A fractional `visibility` switches the owned material to test + blend; only an `alwaysBlend` binding uses plain blend. Changing the default to blend needs an on-device fill-rate measurement first.
- Sampling is pixel-art: NEAREST, no mips, anisotropy 1, through a dedicated `ResourceCache` sampling wrapper (`PIXEL_ART_TEXTURE_SAMPLING`) so a mipped 3D load of the same texture cannot bleed. Sprite textures stay uncompressed.
- Sprites are made with New Asset and reference an imported Texture atlas; there is no atlas-JSON or loose-frame importer.

## Ownership

| Area | Source |
| --- | --- |
| Sprite payload, `spriteClipFrameAt`, `spriteCollisionToBox2d` | [`packages/assets/src/sprite-payload.ts`](../../../packages/assets/src/sprite-payload.ts) |
| Sprite Animation payload, `hydrateSpriteAnimationPixelSizes` | [`packages/assets/src/sprite-animation-payload.ts`](../../../packages/assets/src/sprite-animation-payload.ts) |
| Quad builder (`createSpriteQuad`) | [`packages/render/src/sprite-quad.ts`](../../../packages/render/src/sprite-quad.ts) |
| Animation frame apply (`applySpriteAnimFrame`, `applySpriteAnimationAssetFrame`) | [`packages/render/src/anim-apply.ts`](../../../packages/render/src/anim-apply.ts) |
| Pixel-art sampling wrapper | [`packages/render/src/resource-cache.ts`](../../../packages/render/src/resource-cache.ts) |
| Albedo binding and alpha mode (`applyAlbedoTexture`) | [`packages/render/src/mesh-assets.ts`](../../../packages/render/src/mesh-assets.ts) |
| Box2D collider sync (`PhysicsWorldSync`) | [`packages/runtime/src/physics-sync.ts`](../../../packages/runtime/src/physics-sync.ts) |

## Sprite asset

| Field | Role |
| --- | --- |
| `textureGuid` | Atlas texture |
| `frames` | `{ name, u, v, uSize, vSize, durationMs, pivot, collision? }`; `collision` is a normalized AABB, default `{0,0,1,1}` |
| `clips` | Named frame-index sequences (legacy playback; not edited in the Sprite editor) |
| `pixelsPerUnit` | Default 100 |

Pivot is normalized with v down; the quad is offset so the pivot sits on the actor origin, which is where `spriteCollisionToBox2d` centers the box collider.

## Sprite Animation asset

- Separate `.spriteanim.babasset` in the Content Browser Animation group. Payload: `frameDurationMs` (default 100) and `frames[]` of `{ textureGuid, durationMsOverride?, durationMs, pivot, collision, width?, height? }` — one Texture per frame, full UVs.
- Effective duration = sum of per-frame durations (`durationMs` when `durationMsOverride` is true, else `frameDurationMs`).
- Missing `width` / `height` are stamped from the Texture image (PNG, JPEG, WebP, GIF) in the editor; Play and the player fill them from catalog Texture sizes, else source bytes (`hydrateSpriteAnimationPixelSizes`).
- Header `dependencies[]` lists frame Textures for Show References and export closure.
- Animation Graph and Behaviour Tree **Sprite** clips pick Sprite Animation assets, not Sprite assets. Legacy Sprite guid + clip name still resolves through `spriteClipFrameAt`.

## Runtime and render

- Play loads sprite payloads from scene `SpriteComponent.assetGuid` (the asset need not be open). Play `assignMesh` with `meshKind: "sprite"` builds the same quad as the editor.
- For a Sprite Animation clip, `applySpriteAnimationAssetFrame` binds that frame's Texture, resizes the quad from pixels / `pixelsPerUnit` and re-offsets the pivot.
- With a `box2d` `ColliderComponent`, `PhysicsWorldSync` maps the current frame's collision AABB through `spriteCollisionToBox2d` every tick while a Sprite Animation plays. Leaving a sprite clip clears the override. Circle / capsule / polygon colliders stay as authored.
- Trace frames record each actor's Sprite Animation clip; restore reapplies it (or clears it).
- 2D projection golden: a sprite at world +X renders right of origin (left-handed, camera at −Z).

## Editor

- Sprite and Sprite Animation documents are DockView shells (Preview + Details), composed from catalog components. The Texture picker shows the asset identity (icon, name, type), never a raw guid.
- Preview crops the frame on a checkerboard with pivot crosshair and a draggable collision AABB overlay.

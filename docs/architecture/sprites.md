# Sprites (P9)

Sprite assets, deterministic atlas packing, and `SpriteComponent` as a UV-baked quad mesh (engineplan §13.2). Not `BABYLON.Sprite` — that type is not a Mesh, so it cannot parent, take a shader, hold a physics shape, or share the gizmo path.

Thin instances and merged-static batching stay out of v1 (measure later).

## Asset

Sprite payload (document chunk, or import result):

| Field | Role |
| --- | --- |
| `textureGuid` | atlas (or packed) texture |
| `frames` | `{ name, u, v, uSize, vSize, durationMs, pivot, collision? }` — `collision` is a normalized AABB `{ x, y, width, height }` defaulting to full image `{0,0,1,1}` |
| `clips` | named sequences of frame indices (legacy atlas playback; AnimGraph sprite clips pick **Sprite Animation** instead) |
| `pixelsPerUnit` | default 100 (project 2D scale) |

Import accepts **pre-packed JSON** or **loose frames**. Loose frames run a **deterministic rectangle packer** in `@babylonslate/assets` (padding + edge extrusion), golden-tested. Pixel-art policy already keeps sprites uncompressed (P2). Sampling at texture creation: **NEAREST**, no mips, anisotropic 1 (resource cache canonical sampling).

## `SpriteComponent`

A **quad mesh** with the current frame baked into UVs. Editor `EditorSceneSync` replaces the box proxy with that quad and assigns `ResourceCache.getTexture(textureGuid)` as the unlit albedo/emissive (nearest, no mips) when Play/editor collected the Texture asset's `pixels`/`source` bytes. Alpha-test default; blending opt-in via existing `sorting.ts` `alphaIndex`. Play `assignMesh` with `meshKind: "sprite"` creates the same textured quad. Play loads sprite payloads from scene `SpriteComponent.assetGuid` (the asset does not need to be an open tab). `spriteClipFrameAt` picks a named clip frame from normalised time for **legacy** Sprite clips. When `animState.clipKind === "sprite"` and `clipAssetGuid` is a Sprite Animation, render `applySpriteAnimationAssetFrame` binds that frame’s Texture (full UVs) and pivot on the quad.

When the actor also has `ColliderComponent` with shape `box2d`, `PhysicsWorldSync` maps the **current** frame AABB (minus pivot) through `spriteCollisionToBox2d` using texture pixels / `pixelsPerUnit`, and updates each tick while a Sprite Animation plays. If the Animation guid is missing, it falls back to the Sprite clip named on `animState`. Circle / capsule / polygon colliders are left as authored.

Golden: a sprite at world +X renders **right of origin** (Babylon left-handed 2D, camera at −Z — same trap as [render.md](render.md) 2D projection).

## Sprite Animation

Separate asset (`.spriteanim.babasset`) in the Content Browser **Animation** group (Lucide `Film`). Payload:

```ts
SpriteAnimationPayload = {
  frames: Array<{
    textureGuid: string;
    durationMs: number;
    pivot: { x: number; y: number }; // default {0.5,0.5}
    collision: SpriteCollision;      // default {0,0,1,1}
    width?: number;
    height?: number;
  }>;
}
```

DockView **Preview** + **Details** (same checklist as Sprite). Preview: checkerboard, current frame, pivot crosshair, AABB overlay, frame strip. Details: Texture `AssetPicker`, duration, pivot, collision numbers. Header `dependencies[]` lists frame `textureGuid`s for Show References and export closure.

AnimGraph **Sprite** clip kind picks this asset (not Sprite). Duration for the evaluator is `sum(durationMs)`.

## Editor

Sprite document workspace is a DockView (**Preview** + **Details**). Details: `AssetPicker` filtered to Texture (`property-texture` / `sprite-texture-picker`) showing icon, name, and **Texture** (not the guid), pixels per unit, first-frame pivot and duration, collision numbers, and the first clip name. Preview (`sprite-preview`) loads the Texture `pixels` chunk, crops the current frame UVs on a checkerboard, overlays a live pivot crosshair, and a dashed AABB (`SpriteCollisionOverlay`: 8 handles, drag to shrink/move). Empty texture shows a muted empty state. Compose from [components.md](components.md).

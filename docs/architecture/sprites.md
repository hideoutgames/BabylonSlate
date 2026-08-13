# Sprites (P9)

Sprite assets, deterministic atlas packing, and `SpriteComponent` as a UV-baked quad mesh (engineplan §13.2). Not `BABYLON.Sprite` — that type is not a Mesh, so it cannot parent, take a shader, hold a physics shape, or share the gizmo path.

Thin instances and merged-static batching stay out of v1 (measure later).

## Asset

Sprite payload (document chunk, or import result):

| Field | Role |
| --- | --- |
| `textureGuid` | atlas (or packed) texture |
| `frames` | `{ name, u, v, uSize, vSize, durationMs, pivot }` |
| `clips` | named sequences of frame indices |
| `pixelsPerUnit` | default 100 (project 2D scale) |

Import accepts **pre-packed JSON** or **loose frames**. Loose frames run a **deterministic rectangle packer** in `@babylonslate/assets` (padding + edge extrusion), golden-tested. Pixel-art policy already keeps sprites uncompressed (P2). Sampling at texture creation: **NEAREST**, no mips, anisotropic 1 (resource cache canonical sampling).

## `SpriteComponent`

A **quad mesh** with the current frame baked into UVs. Editor `EditorSceneSync` replaces the box proxy with that quad. Alpha-test default; blending opt-in via existing `sorting.ts` `alphaIndex`. Play `assignMesh` with `meshKind: "sprite"` creates the same quad. `spriteClipFrameAt` picks a named clip frame from normalised time; render `applySpriteAnimFrame` rebakes UVs when an `animState` command targets a sprite clip.

Golden: a sprite at world +X renders **right of origin** (Babylon left-handed 2D, camera at −Z — same trap as [render.md](render.md) 2D projection).

## Editor

Sprite document workspace: frame timeline, pivot, texture picker. Compose from [components.md](components.md).

/**
 * Test-build-only proof that Play world sprite batching (`world-sprite-batcher.ts`) changes no pixel: one fixed world
 * drawn through the production scene view with batching on and with every sprite a quad of its own (as
 * `worlddebug spritebatching off` draws them). It holds overlapping sprites of one sorting order spawned out of
 * order, a tilemap of that order whose actor sorts between theirs, a mirrored sprite, a crossfading animated sprite (two
 * sheet cells at once), a lit sprite receiving the sun's shadow and a sprite casting it onto a wall. Small nearest
 * images, so the batches sample the Scene's shared page. The spec compares the two runs' frames byte for byte, still
 * and after the sprites move, and the batched run draws fewer calls.
 */
import { Engine } from "@babylonjs/core/Engines/engine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { Light } from "@babylonjs/core/Lights/light";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import {
  createDefaultSpriteAnimationSheet, createDefaultTilemapPayload, normalizeTilesetPayload, setTile,
  type SpriteAnimationPayload, type SpritePayload,
} from "@haptic/assets";
import { SNAPSHOT_FLAG_VISIBLE } from "@haptic/bridge";
import { normalizeRenderEffectsSettings, normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, configureEditorRenderingGroups } from "@haptic/render";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
// The engine-wide registrations a shipped Engine loads before it exists (multiple render targets among them).
import "@haptic/render/babylon-registrations";
import { applyAnimStateToScene, sceneAnimHostFromBinding } from "@haptic/render/editor-proofs";
import { pendingDriverEffects } from "@haptic/render/editor-proofs";
import { readEngineDrawCalls } from "@haptic/render/editor-proofs";
import { ownedVisualTexturePreparation } from "@haptic/render/editor-proofs";
import { encodeRgbaPng } from "@haptic/render/editor-proofs";
import { ResourceCache } from "@haptic/render/editor-proofs";
import { setSceneRenderSettings } from "@haptic/render/editor-proofs";
import { applyAssignMesh, applySnapshotToScene, createSnapshotSceneBinding, disposeSnapshotBinding } from "@haptic/render/editor-proofs";
import { setSceneWorldSpriteBatching, worldSpriteBatchStats } from "@haptic/render/editor-proofs";

const WIDTH = 320;
const HEIGHT = 200;

/** A 16 px image of numeric content: quadrants of colour, a hole the cutout drops and a ramp of alpha. */
function image(seed: number, width = 16, height = 16): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = (x * 16 + seed * 70) & 255;
      pixels[offset + 1] = (y * 16 + seed * 30) & 255;
      pixels[offset + 2] = ((x ^ y) * 16 + seed * 50) & 255;
      pixels[offset + 3] = x > 5 && x < 9 && y > 5 && y < 9 ? 0 : y > 12 ? x * 16 : 255;
    }
  }
  return encodeRgbaPng(width, height, pixels);
}

function sprite(textureGuid: string, pivot = { x: 0.5, y: 0 }): SpritePayload {
  return { textureGuid, pixelsPerUnit: 20, pivot, collision: { x: 0, y: 0, width: 1, height: 1 }, width: 16, height: 16 };
}

interface Placed { slotId: number; x: number; y: number; z?: number; sx?: number }

export type WorldSpriteBatchingFrame = { pixels: number[]; draws: number; batches: number; batched: number };

/** Draws the world once, with batching on or off; its still frame and its frame after the sprites move. */
export async function runWorldSpriteBatchingProof(batching: boolean): Promise<{
  width: number; height: number; still: WorldSpriteBatchingFrame; moved: WorldSpriteBatchingFrame; renderer: string;
}> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  const scene = new Scene(engine);
  const resourceCache = new ResourceCache();
  const binding = createSnapshotSceneBinding();
  try {
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);
    configureEditorRenderingGroups(scene);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      effects: normalizeRenderEffectsSettings({}),
      quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } }),
      shadows: normalizeShadowSettings({ cascades: 1, mapSize: 512, distance: 20 }),
    });
    const camera = new FreeCamera("Main Camera", new Vector3(0, 1.2, -7), scene);
    camera.setTarget(new Vector3(0, 1.2, 0));
    camera.minZ = 0.1;
    camera.maxZ = 40;
    scene.activeCamera = camera;
    setSceneWorldSpriteBatching(scene, batching);

    // A wall behind the sprites that takes the casting sprite's shadow.
    const wallDocument = createDefaultMaterialDocument("wall");
    const lowered = lowerMaterialDocument(wallDocument);
    if (!lowered.ok) throw new Error("The wall's Material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "wall" });
    if (!compiled.ok) throw new Error("The wall's Material did not compile");
    await compiled.ready;
    const wall = MeshBuilder.CreateBox("wall", { width: 12, height: 6, depth: 0.2 }, scene);
    wall.position.set(0, 1.5, 0.6);
    wall.material = compiled.material;
    const lights: Light[] = [];
    const fill = new HemisphericLight("fill", Vector3.Up(), scene);
    applyAuthoredLightProperties(fill, { color: [0.6, 0.65, 0.8], intensity: 0.4, castShadows: false, range: 12, outerAngle: 70, innerAngle: 40, groundColor: [0.2, 0.2, 0.2] });
    const sun = new DirectionalLight("sun", new Vector3(-0.35, -0.4, 1).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 2.5, castShadows: true, range: 12, outerAngle: 70, innerAngle: 40, groundColor: [0.2, 0.2, 0.2] });
    lights.push(fill, sun);

    binding.resourceCache = resourceCache;
    binding.pixelsPerUnit = 20;
    binding.textureBytes = new Map([
      ["tex-a", image(0)], ["tex-b", image(1)], ["tex-c", image(2)], ["tex-sheet", image(3, 32, 16)], ["tex-tiles", image(4, 32, 16)],
    ]);
    binding.spritePayloads = new Map([
      ["sprite-a", sprite("tex-a")], ["sprite-b", sprite("tex-b")], ["sprite-c", sprite("tex-c")], ["sprite-sheet", sprite("tex-sheet")],
    ]);
    const cell = (index: number) => ({
      textureGuid: "tex-sheet", cell: index, durationMs: 100, pivot: { x: 0.5, y: 0 }, collision: { x: 0, y: 0, width: 1, height: 1 },
      width: 16, height: 16, uv: { u0: index * 0.5, v0: 0, u1: index * 0.5 + 0.5, v1: 1 },
    });
    const walk: SpriteAnimationPayload = {
      frameDurationMs: 100, source: "sheet",
      sheet: { ...createDefaultSpriteAnimationSheet(), textureGuid: "tex-sheet", cellWidth: 16, cellHeight: 16 },
      frames: [cell(0), cell(1)],
    };
    binding.spriteAnimations = new Map([["walk", walk]]);
    let map = { ...createDefaultTilemapPayload(), tilesets: [{ guid: "tiles", firstGid: 1, tileCount: 2 }] };
    for (let x = 0; x < 6; x += 1) map = setTile(map, "layer-1", x, 0, 1 + (x % 2));
    binding.tilemaps = new Map([["map", map]]);
    binding.tilesets = new Map([["tiles", normalizeTilesetPayload({ textureGuid: "tex-tiles", atlasWidth: 32, atlasHeight: 16, tileWidth: 16, tileHeight: 16 })]]);

    const assign = (slotId: number, guid: string, actorGuid: string, extra: Partial<Parameters<typeof applyAssignMesh>[2]> = {}) =>
      applyAssignMesh(scene, binding, {
        type: "assignMesh", slotId, meshKind: "sprite", meshAssetGuid: guid, actorGuid, sortingLayer: "Default", orderInLayer: 0,
        castShadows: false, receiveShadows: true, shadingMode: "unlit", ...extra,
      } as Parameters<typeof applyAssignMesh>[2]);
    // Overlapping sprites of one order, spawned out of their actors' order, around a tilemap whose actor sorts between.
    assign(1, "sprite-a", "actor-e");
    assign(2, "sprite-b", "actor-a");
    assign(3, "sprite-c", "actor-c");
    assign(4, "sprite-a", "actor-g");
    assign(5, "sprite-b", "actor-b");
    applyAssignMesh(scene, binding, {
      type: "assignMesh", slotId: 6, meshKind: "tilemap", meshAssetGuid: "map", actorGuid: "actor-d", sortingLayer: "Default",
      orderInLayer: 0, castShadows: false, receiveShadows: true, shadingMode: "unlit",
    } as Parameters<typeof applyAssignMesh>[2]);
    // Mirrored, crossfading, lit receiving and casting sprites.
    assign(7, "sprite-c", "actor-f");
    assign(8, "sprite-sheet", "actor-h");
    assign(9, "sprite-a", "actor-i", { shadingMode: "3d" });
    assign(10, "sprite-b", "actor-j", { shadingMode: "3d", castShadows: true });
    assign(11, "sprite-c", "actor-k", { shadingMode: "3d" });

    const place = (frameId: number, shift: number) => {
      const actors: Placed[] = [
        { slotId: 1, x: -2.6 + shift, y: 0.3 }, { slotId: 2, x: -2.9, y: 0.5 }, { slotId: 3, x: -2.3, y: 0.2 + shift },
        { slotId: 4, x: -2.0, y: 0.4 }, { slotId: 5, x: -2.75 - shift, y: 0.65 }, { slotId: 6, x: -3.1, y: 0.9 },
        { slotId: 7, x: -0.9, y: 0.4, sx: -1 }, { slotId: 8, x: 0.1 + shift, y: 0.4 }, { slotId: 9, x: 1.2, y: 0.2, z: 0.3 },
        { slotId: 10, x: 2.1, y: 0.6 - shift, z: -0.6 }, { slotId: 11, x: 2.8, y: 0.3, z: 0.4 },
      ];
      applySnapshotToScene(scene, binding, {
        frameId, tickIndex: frameId, actorCount: actors.length,
        actors: actors.map((actor) => ({
          slotId: actor.slotId, flags: SNAPSHOT_FLAG_VISIBLE, position: new Vector3(actor.x, actor.y, actor.z ?? 0),
          rotation: Quaternion.Identity(), scale: new Vector3(actor.sx ?? 1, 1, 1),
        })),
      });
    };
    const animHost = sceneAnimHostFromBinding(binding, { spritePayloads: binding.spritePayloads, spriteAnimations: binding.spriteAnimations });
    const crossfade = (time: number) => applyAnimStateToScene(animHost, {
      type: "animState", slotId: 8, stateId: "walk", normalisedTime: time, blendWeights: { walk: 0.6, idle: 0.4 },
      layers: [
        { stateId: "walk", clipAssetGuid: "walk", clipName: "Walk", clipKind: "sprite", normalisedTime: time, weight: 0.6 },
        { stateId: "idle", clipAssetGuid: "walk", clipName: "Idle", clipKind: "sprite", normalisedTime: 0.9 - time, weight: 0.4 },
      ],
    });
    place(1, 0);
    crossfade(0.1);
    await Promise.all([...binding.meshes.values()].map((root) => ownedVisualTexturePreparation(root)));

    const view = new SceneRenderCoordinator(scene, { leanPreparation: true });
    const frame = () => {
      engine.beginFrame();
      try { return view.render(); } finally { engine.endFrame(); }
    };
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 16));
    const deadline = performance.now() + 90_000;
    for (;;) {
      const result = frame();
      const shadowsDrawn = lights.every((light) => !light.shadowEnabled || (light.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() !== 1);
      if (result.rendered && result.readyForPresentation && shadowsDrawn && !pendingDriverEffects(engine).length) break;
      if (performance.now() > deadline) throw new Error("The world did not settle");
      await tick();
    }
    const read = async (): Promise<WorldSpriteBatchingFrame> => {
      // A few settled frames, nothing compiling, then the last one's image and draws.
      let draws = 0;
      for (let index = 0; index < 4; index += 1) {
        while (pendingDriverEffects(engine).length) await tick();
        const before = readEngineDrawCalls(engine as unknown as Parameters<typeof readEngineDrawCalls>[0]);
        const result = frame();
        draws = readEngineDrawCalls(engine as unknown as Parameters<typeof readEngineDrawCalls>[0]) - before;
        if (!result.rendered || !result.readyForPresentation) index -= 1;
        await tick();
      }
      const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
      const stats = worldSpriteBatchStats(scene);
      return {
        pixels: Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)), draws,
        batches: stats?.batches ?? 0, batched: stats?.sprites ?? 0,
      };
    };
    const still = await read();
    place(2, 0.15);
    crossfade(0.6);
    const moved = await read();
    view.dispose();
    return { width: WIDTH, height: HEIGHT, still, moved, renderer: engine.getGlInfo().renderer };
  } finally {
    disposeSnapshotBinding(binding);
    resourceCache.dispose();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}

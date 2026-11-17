import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { FromHalfFloat } from "@babylonjs/core/Misc/textureTools";
import { createDefaultSpritePayload } from "@haptic/assets";
import { parseLight2DProperties, type Light2DProperties } from "@haptic/core";
import { afterEach, describe, expect, it } from "vitest";
import { HapticLightingBlock } from "./haptic-lighting-block";
import { Light2DGroup } from "./light-2d-group";
import {
  LIGHT_2D_MAXIMUM, add2DLight, add2DOccluder, bind2DLights, bind2DShadows, pack2DLights, setOccluderPose, setOccluderShapes, setScene2DLighting,
  write2DLights, type Light2DRecord, type Occluder2DRecord,
} from "./lights-2d";
import { applyAlbedoTexture, installTextureBytes } from "./mesh-assets";
import { ResourceCache } from "./resource-cache";
import { createSpriteQuad } from "./sprite-quad";
import { Light2DBlock } from "./unlit-lighting-blocks";

const record = (properties: Partial<Light2DProperties>, x = 0, y = 0, direction: [number, number] = [0, 1]): Light2DRecord => ({
  properties: parseLight2DProperties(properties), x, y, directionX: direction[0], directionY: direction[1],
});
const words = () => new Float32Array(LIGHT_2D_MAXIMUM * 16);
/** Reads the first shadowed light's row of the Scene's 2D shadow map, as its last upload left it. Call before the first write. */
function shadowRowReader(scene: Scene): (bin: number) => number {
  let uploaded: Uint16Array | undefined;
  bind2DShadows(scene, {
    setTexture: (_name: string, texture: { update(data: Uint16Array): void }) => {
      const update = texture.update.bind(texture);
      texture.update = (data) => { uploaded = data; update(data); };
    },
  } as unknown as Effect);
  return (bin) => FromHalfFloat(uploaded![bin]!);
}

const lit = { lightsEnabled: true, camera: null, origin: { x: 0, y: 0 } };

describe("pack2DLights", () => {
  it("sums Global lights into the ambient and packs a Point light's place, colour and cone", () => {
    const out = words();
    const packed = pack2DLights([
      record({ lightKind: "global", color: [1, 0.5, 0], intensity: 0.5 }),
      record({ lightKind: "global", color: [0, 0, 1], intensity: 2 }),
      record({ color: [1, 0.5, 0.25], intensity: 2, radius: 4, innerRadius: 1, outerAngle: 120, innerAngle: 60 }, 3, -2, [0, -1]),
    ], { ...lit, origin: { x: 1, y: 1 } }, out);
    expect(packed).toEqual({ count: 1, ambient: [0.5, 0.25, 2], limited: [], shadowed: [] });
    // Relative to the floating origin; cos(60°) and cos(30°) are the half-angles' cosines.
    expect([...out.subarray(0, 16)].map((value) => Number(value.toFixed(4)))).toEqual([
      2, -3, 4, 1, 2, 1, 0.5, 1, 0, -1, 0.5, 0.866, 0, 0, 0, 0,
    ]);
  });

  it("gives shadow map rows to the first shadow-casting Point lights it holds, only while there are casters", () => {
    const lights = [record({ castShadows: false }), record({}), record({})];
    const out = words();
    const packed = pack2DLights(lights, { ...lit, shadows: true }, out);
    expect(packed.shadowed).toEqual([lights[1], lights[2]]);
    // Row v at its texel centre (of eight rows), and the flag; none for the light that casts no shadow.
    expect([...out.subarray(12, 16), ...out.subarray(28, 32), ...out.subarray(44, 48)]).toEqual([0, 0, 0, 0, 0.0625, 1, 0, 0, 0.1875, 1, 0, 0]);
    expect(pack2DLights(lights, lit, words()).shadowed).toEqual([]);
  });

  it("marks a full-circle light as having no cone", () => {
    const out = words();
    pack2DLights([record({})], lit, out);
    expect(out[7]).toBe(0);
  });

  it("skips a disabled light, one of zero intensity and one with an error", () => {
    const broken = { ...record({}), error: "2D Light requires a finite transform." };
    const packed = pack2DLights([record({ enabled: false }), record({ intensity: 0 }), broken, record({ lightKind: "global", enabled: false })], lit, words());
    expect(packed).toEqual({ count: 0, ambient: [0, 0, 0], limited: [], shadowed: [] });
  });

  it("keeps the Point lights nearest the camera, less their radius, and reports the rest as limited", () => {
    const far = Array.from({ length: LIGHT_2D_MAXIMUM }, (_, index) => record({ radius: 1 }, 100 + index, 0));
    const wide = record({ radius: 200 }, 150, 0);
    const near = record({ radius: 1 }, 2, 0);
    const out = words();
    const packed = pack2DLights([...far, wide, near], { ...lit, camera: { x: 0, y: 0 } }, out);
    expect(packed.count).toBe(LIGHT_2D_MAXIMUM);
    // The wide light reaches the camera, so it outranks the near one; the two farthest small lights are left out.
    expect([out[0], out[16]]).toEqual([150, 2]);
    expect(packed.limited).toEqual(far.slice(-2));
  });

  it("packs a white ambient and no lights while the Scene's lights are off (the Unlit viewport)", () => {
    const out = words();
    expect(pack2DLights([record({}), record({ lightKind: "global", intensity: 3 })], { ...lit, lightsEnabled: false }, out))
      .toEqual({ count: 0, ambient: [1, 1, 1], limited: [], shadowed: [] });
    expect(out.every((value) => value === 0)).toBe(true);
  });
});

describe("2D shadow casters", () => {
  it("poses again only the casters that changed, and redraws the shadows they reach", () => {
    const engine = new NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
    const scene = new Scene(engine);
    const bound: unknown[] = [];
    // The block and its per-frame write start with the first draw that binds it.
    const bind = () => bind2DLights(scene, { bindUniformBuffer: (buffer: unknown) => bound.push(buffer) } as unknown as Effect);
    add2DLight(scene, record({ radius: 10 }, 0, 0));
    const square = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
    /** A unit-square caster whose `dirty` flag counts how often it is looked at. */
    const caster = (x: number, y: number) => {
      const occluder: Occluder2DRecord = { shapes: [{ closed: true, points: square }], x, y, angle: 0, dirty: true, world: [] };
      let dirty = true;
      const looks = { count: 0 };
      Object.defineProperty(occluder, "dirty", { get: () => (looks.count++, dirty), set: (value: boolean) => { dirty = value; } });
      const remove = add2DOccluder(scene, occluder);
      return { occluder, looks, remove };
    };
    const still = Array.from({ length: 20 }, (_, at) => caster(20 + at * 2, 30));
    const mover = caster(3, 0);
    const map = shadowRowReader(scene);
    bind();
    // Straight right of the light (bin 256), shadow starts where the ray leaves the mover: 3.5 of 10.
    expect(map(256)).toBeCloseTo(0.35, 2);
    expect(mover.occluder.world[0]!.minX).toBe(2.5);
    for (const entry of [...still, mover]) entry.looks.count = 0;
    // Frames in which nothing moves look at no caster.
    for (let frame = 0; frame < 5; frame++) write2DLights(scene);
    expect(still.reduce((sum, entry) => sum + entry.looks.count, 0) + mover.looks.count).toBe(0);
    // A moved caster is posed again, alone, and the shadow follows it.
    setOccluderPose(mover.occluder, 5, 0, 0);
    write2DLights(scene);
    expect(mover.occluder.world[0]!.minX).toBe(4.5);
    expect(map(256)).toBeCloseTo(0.55, 2);
    expect(still.reduce((sum, entry) => sum + entry.looks.count, 0)).toBe(0);
    // So is one whose outlines were replaced, and one that turned.
    setOccluderShapes(mover.occluder, [{ closed: true, points: square.map((value) => value * 2) }]);
    write2DLights(scene);
    expect(map(256)).toBeCloseTo(0.6, 2);
    setOccluderPose(mover.occluder, 5, 0, Math.PI / 4);
    write2DLights(scene);
    expect(map(256)).toBeCloseTo((5 + Math.SQRT2) / 10, 2);
    // A caster moved and then removed before the next write casts nothing, and is not posed.
    setOccluderPose(mover.occluder, 2, 0, 0);
    mover.remove();
    write2DLights(scene);
    expect(map(256)).toBe(1);
    expect(mover.occluder.world[0]!.minX).not.toBe(1.5);
    // A caster moved while it is out of the Scene is posed when it joins again.
    setOccluderPose(mover.occluder, 4, 0, 0);
    add2DOccluder(scene, mover.occluder);
    write2DLights(scene);
    expect(map(256)).toBeCloseTo(0.5, 2);
    expect(bound).toHaveLength(1);
    scene.dispose();
    engine.dispose();
  });
});

describe("2D light posing and 2D surfaces", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => { dispose?.(); dispose = undefined; });

  function sceneFixture() {
    const engine = new NullEngine({ renderWidth: 64, renderHeight: 64, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
    const scene = new Scene(engine);
    const cache = new ResourceCache();
    dispose = () => { scene.dispose(); cache.dispose(); engine.dispose(); };
    const sprite = createDefaultSpritePayload();
    sprite.textureGuid = "atlas";
    const assets = { resourceCache: cache, textureBytes: installTextureBytes(new Map([["atlas", new Uint8Array([1, 2, 3])]]))! };
    const spriteMesh = (name: string, shadingMode?: "2d" | "3d" | "unlit") => {
      const mesh = createSpriteQuad(scene, name, sprite);
      applyAlbedoTexture(mesh, scene, "atlas", assets, shadingMode ? { shadingMode } : {});
      return mesh;
    };
    return { scene, spriteMesh };
  }

  it("poses a light from its actor's world and local chain, its cone along its turned +Y", () => {
    const { scene } = sceneFixture();
    const group = new Light2DGroup(scene);
    group.update([{ id: "lamp", properties: parseLight2DProperties({}), transforms: [
      { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    ] }]);
    group.setWorld(Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Vector3.Forward(), Math.PI), new Vector3(5, 2, 0)));
    const posed = group.record("lamp")!;
    expect([posed.x, posed.y, posed.directionX, posed.directionY].map((value) => Number(value.toFixed(5)) + 0)).toEqual([4, 2, 0, -1]);
    group.dispose();
  });

  it("draws Shading Mode 2D unlit until the Scene has 2D lighting, then lit by 2D lights; Unlit stays unlit", () => {
    const { scene, spriteMesh } = sceneFixture();
    const twoD = spriteMesh("two-d", "2d");
    const unlit = spriteMesh("unlit", "unlit");
    const plain = spriteMesh("no-mode");
    const blocks = (mesh: typeof twoD) => (mesh.material as NodeMaterial).attachedBlocks;
    expect(blocks(twoD).some((block) => block instanceof Light2DBlock)).toBe(false);
    const before = twoD.material;
    expect(unlit.material).toBe(before);

    setScene2DLighting(scene, true);
    expect(blocks(twoD).some((block) => block instanceof Light2DBlock)).toBe(true);
    expect(unlit.material).toBe(before);
    // Surfaces without a Shading Mode (text, panels, UI controls) never light.
    expect(plain.material).toBe(before);

    setScene2DLighting(scene, false);
    expect(twoD.material).toBe(before);
  });

  it("draws Shading Mode 3D through the light block, whatever the Scene's 2D lighting", () => {
    const { scene, spriteMesh } = sceneFixture();
    const threeD = spriteMesh("three-d", "3d");
    const material = threeD.material as NodeMaterial;
    expect(material.attachedBlocks.some((block) => block instanceof HapticLightingBlock)).toBe(true);
    expect(material.attachedBlocks.some((block) => block instanceof Light2DBlock)).toBe(false);
    setScene2DLighting(scene, true);
    expect(threeD.material).toBe(material);
  });
});

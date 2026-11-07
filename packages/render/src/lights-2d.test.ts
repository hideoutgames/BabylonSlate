import { Matrix, NullEngine, Quaternion, Scene, Vector3, type NodeMaterial } from "@babylonjs/core";
import { createDefaultSpritePayload } from "@haptic/assets";
import { parseLight2DProperties, type Light2DProperties } from "@haptic/core";
import { afterEach, describe, expect, it } from "vitest";
import { HapticLightingBlock } from "./haptic-lighting-block";
import { Light2DGroup } from "./light-2d-group";
import { LIGHT_2D_MAXIMUM, pack2DLights, setScene2DLighting, type Light2DRecord } from "./lights-2d";
import { applyAlbedoTexture, installTextureBytes } from "./mesh-assets";
import { ResourceCache } from "./resource-cache";
import { createSpriteQuad } from "./sprite-quad";
import { Light2DBlock } from "./unlit-lighting-blocks";

const record = (properties: Partial<Light2DProperties>, x = 0, y = 0, direction: [number, number] = [0, 1]): Light2DRecord => ({
  properties: parseLight2DProperties(properties), x, y, directionX: direction[0], directionY: direction[1],
});
const words = () => new Float32Array(LIGHT_2D_MAXIMUM * 16);
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

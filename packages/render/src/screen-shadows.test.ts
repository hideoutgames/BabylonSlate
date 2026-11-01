import { afterEach, describe, expect, it } from "vitest";
import { DirectionalLight, FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { createAtlasCascadedShadowGenerator } from "./shadow-atlas";
import { screenShadowThicknessCaps } from "./screen-shadows";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function host() {
  const engine = new NullEngine();
  engines.push(engine);
  engine._features.supportCSM = true;
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 1.9, -5.5), scene);
  camera.setTarget(new Vector3(0, 1.35, 0));
  camera.minZ = 0.1;
  camera.maxZ = 400;
  const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.4), scene);
  return { scene, camera, sun };
}

describe("screen shadow thickness caps", () => {
  it("cap the march's assumed thickness at each drawn cascade's filter reach in the world, so it adds only contacts finer than the cascades", () => {
    const { scene, camera, sun } = host();
    const generator = createAtlasCascadedShadowGenerator(sun, 1024, 3, 2048, camera)!;
    generator.shadowMaxZ = 60;
    // Not yet drawn: no cascade to cap by, so the march keeps its general thickness.
    expect(screenShadowThicknessCaps(sun, camera)).toBeNull();
    scene.incrementRenderId();
    scene.updateTransformMatrix(true);
    generator.getShadowMap()!.render();
    const result = screenShadowThicknessCaps(sun, camera)!;
    expect(result.ends).toEqual([...generator.cascadeEnds.slice(0, 3), -1]);
    // Four texels of each cascade's 1024-texel tile across its orthographic width (2 / the projection's x scale).
    [0, 1, 2].forEach((cascade) =>
      expect(result.caps[cascade]).toBeCloseTo(4 * 2 / Math.abs(generator.getCascadeProjectionMatrix(cascade)!.m[0]!) / 1024, 6));
    expect(result.caps[0]).toBeLessThan(result.caps[1]!);
    expect(result.caps[1]).toBeLessThan(result.caps[2]!);
    // The Basic 3D mannequin's case: a head 0.15 m in front of a ray from the arm beside it, 5.3 m from the camera. The
    // march's bias there (0.004 z + 0.01 over a sun at 0.86) plus the first cascade's reach stays under 0.15 m, so the
    // head no longer reads as blocking a sun the cascades show reaching the arm; the old thickness, 0.15 + 0.02 z, took it.
    expect(5.3).toBeLessThan(result.ends[0]!);
    expect((0.004 * 5.3 + 0.01) / 0.86 + result.caps[0]!).toBeLessThan(0.15);
  });

  it("leave the general thickness to a sun without a cascaded map in the atlas", () => {
    const { camera, sun } = host();
    expect(screenShadowThicknessCaps(sun, camera)).toBeNull();
  });
});

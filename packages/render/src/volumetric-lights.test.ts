import {
  DirectionalLight,
  FreeCamera,
  NullEngine,
  PointLight,
  Scene,
  SpotLight,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { DEFAULT_RENDER_EFFECTS } from "@babylonslate/core";
import { expect, it } from "vitest";
import { registerClusteredLightPolicy } from "./clustered-light-policy";
import { selectVolumetricLights } from "./volumetric-lights";

it("bounds contributors, includes borrowed cluster children and follows parent transforms", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.getViewMatrix();
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    const near = new PointLight("near", new Vector3(1, 0, 0), scene);
    const child = new SpotLight(
      "borrowed",
      new Vector3(2, 0, 0),
      Vector3.Down(),
      1,
      1,
      scene,
    );
    const far = new PointLight("far", new Vector3(100, 0, 0), scene);
    far.range = 2;
    const parent = new TransformNode("moving parent", scene);
    child.parent = parent;
    scene.removeLight(child);
    const unregister = registerClusteredLightPolicy(scene, {
      sync() {},
      limits: () => [],
      target: () => undefined,
      ownsContainer: () => false,
      allowsLocal: () => true,
      clusteredCount: () => 1,
      authoredLights: () => [child],
    });
    const settings = {
      ...DEFAULT_RENDER_EFFECTS.volumetricLighting,
      enabled: true,
      maxLights: 3,
      maxDistance: 10,
    };
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([
      sun,
      near,
      child,
    ]);
    expect(
      selectVolumetricLights(scene, camera, { ...settings, maxLights: 2 }),
    ).toEqual([sun, near]);
    parent.setEnabled(false);
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([
      sun,
      near,
    ]);
    parent.setEnabled(true);
    parent.position.x = 100;
    child.range = 2;
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([
      sun,
      near,
    ]);
    near.setEnabled(false);
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([sun]);
    scene.lightsEnabled = false;
    expect(selectVolumetricLights(scene, camera, settings)).toEqual([]);
    unregister();
    child.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, RawTexture, Scene, StandardMaterial } from "@babylonjs/core";
import { internalTexturesHeldByScene } from "./scene-texture-references";

describe("internalTexturesHeldByScene", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    while (engines.length > 0) engines.pop()?.dispose();
  });

  const pixel = (owner: Scene | NullEngine) => RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, owner);

  it("holds what the Scene registers, what its Materials sample and its environment, whichever of them built it", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    // The ResourceCache builds assets on the Engine, so only the Material or the environment reaches the Scene.
    const registered = pixel(scene);
    const sampled = pixel(engine);
    new StandardMaterial("sampler", scene).diffuseTexture = sampled;
    const environment = pixel(engine);
    scene.environmentTexture = environment;
    const brdf = pixel(engine);
    scene.environmentBRDFTexture = brdf;
    // Neither another Scene's texture nor an unreferenced one belongs to it.
    pixel(new Scene(engine));
    pixel(engine);

    expect(internalTexturesHeldByScene(scene)).toEqual(
      new Set([registered, sampled, environment, brdf].map((texture) => texture.getInternalTexture())),
    );
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { Constants, NullEngine, RawTexture, RenderTargetTexture, Scene, StandardMaterial } from "@babylonjs/core";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
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

  it("holds a render target's depth/stencil texture with its colour texture", () => {
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    const scene = new Scene(engine);
    const target = new RenderTargetTexture("target", 4, scene);
    const depth = target.renderTarget!.createDepthStencilTexture(0, false, false, 1, Constants.TEXTUREFORMAT_DEPTH24);
    // A second Scene's target is not this Scene's, depth attachment included.
    const other = new RenderTargetTexture("other", 4, new Scene(engine));
    const otherDepth = other.renderTarget!.createDepthStencilTexture(0, false, false, 1, Constants.TEXTUREFORMAT_DEPTH24);

    const held = internalTexturesHeldByScene(scene);
    expect(held).toEqual(new Set([target.getInternalTexture(), depth]));
    expect(held).not.toContain(otherDepth);
  });
});

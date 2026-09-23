import { afterEach, expect, it } from "vitest";
import {
  DirectionalLight, NullEngine, RawTexture, RenderTargetTexture,
  Scene, ShadowGenerator, Vector3,
} from "@babylonjs/core";
import { normalizeRenderingQuality, qualityPresetPatch } from "@babylonslate/core";
import { applyMaterialTextureAnisotropy, updateSceneRenderingSettings } from "./render-settings";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  engine.getCaps().maxAnisotropy = 16;
  return new Scene(engine);
}

it("changes authored texture quality without broadening an existing shadow map's sampling", () => {
  const scene = fixture();
  const texture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
  const light = new DirectionalLight("sun", Vector3.Down(), scene);
  const shadow = new ShadowGenerator(256, light).getShadowMap()!;
  const apply = (anisotropy: number) => {
    const quality = normalizeRenderingQuality(qualityPresetPatch("low"));
    quality.textures.anisotropy = anisotropy;
    updateSceneRenderingSettings(scene, { quality });
  };
  apply(8);
  expect(texture.anisotropicFilteringLevel).toBe(8);
  expect(shadow.anisotropicFilteringLevel).toBe(1);
  apply(2);
  expect(texture.anisotropicFilteringLevel).toBe(2);
  expect(shadow.anisotropicFilteringLevel).toBe(1);
});

it("preserves render-target sampling even during the synchronous texture-added notification", () => {
  const scene = fixture();
  let targetObserved = false;
  scene.onNewTextureAddedObservable.add((texture) => {
    if (texture instanceof RenderTargetTexture) {
      targetObserved = true;
      // A renderer owns this value even before isRenderTarget is initialized.
      texture.anisotropicFilteringLevel = 1;
    }
    applyMaterialTextureAnisotropy(texture, 8);
  });
  const target = new RenderTargetTexture("owned target", 16, scene);
  expect(targetObserved).toBe(true);
  expect(target.anisotropicFilteringLevel).toBe(1);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
  applyMaterialTextureAnisotropy(texture, 8);
  expect(texture.anisotropicFilteringLevel).toBe(8);
});

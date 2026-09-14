import {
  ShaderMaterial,
  ShaderStore,
  type Observer,
  type RenderTargetTexture,
} from "@babylonjs/core";
import type { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { lightProxyVertexShader } from "@babylonjs/core/Shaders/lightProxy.vertex";
import { checkedShader } from "./checked-shader";

ShaderStore.ShadersStore.slateClusterProxyVertexShader = checkedShader(
  lightProxyVertexShader.shader,
  "cluster camera bounds",
)
  .replace(
    "uniform sampler2D lightDataTexture;",
    "uniform float slateClusterUnbounded;uniform sampler2D lightDataTexture;",
  )
  .replace(
    "vec2 halfTileRes=tileMaskResolution.xy/2.0;",
    "if (slateClusterUnbounded>0.5) { projPosition=position.xy; }\nvec2 halfTileRes=tileMaskResolution.xy/2.0;",
  ).value;

type PinnedBounds = {
  _proxyMaterial: ShaderMaterial;
  _sliceRanges: Float32Array;
};

/**
 * Physical PBR has no finite range cutoff. Its conservative mask covers every
 * visible camera tile and depth slice, while the original packed light data and
 * exact attenuation remain untouched. Finite-range consumers keep native bounds.
 */
export class ClusteredCameraBounds {
  private map: RenderTargetTexture | undefined;
  private observer: Observer<RenderTargetTexture> | undefined;
  private unbounded = false;
  private readonly native: PinnedBounds;

  constructor(private readonly container: ClusteredLightContainer) {
    const native = container as unknown as PinnedBounds;
    if (
      !(native._proxyMaterial instanceof ShaderMaterial) ||
      !(native._sliceRanges instanceof Float32Array)
    )
      throw new Error("Unsupported Babylon clustered camera-bounds layout.");
    this.native = native;
    native._proxyMaterial.shaderPath = {
      vertex: "slateClusterProxy",
      fragment: "lightProxy",
    };
  }

  sync(map: RenderTargetTexture, unbounded: boolean): void {
    this.unbounded = unbounded;
    this.native._proxyMaterial.setFloat(
      "slateClusterUnbounded",
      unbounded ? 1 : 0,
    );
    if (this.map === map) return;
    if (this.map && this.observer)
      this.map.onBeforeBindObservable.remove(this.observer);
    this.map = map;
    // The native observer updates transforms, attenuation data and slices first.
    // Alter only the conservative slice bounds before proxy rendering/binding.
    this.observer = map.onBeforeBindObservable.add(() => {
      if (!this.unbounded) return;
      const ranges = this.native._sliceRanges;
      const count = this.container.lights.length;
      if (ranges.length !== this.container.depthSlices * 2)
        throw new Error("Clustered depth-slice layout changed.");
      for (let slice = 0; slice < ranges.length; slice += 2) {
        ranges[slice] = 0;
        ranges[slice + 1] = Math.max(0, count - 1);
      }
    });
  }

  dispose(): void {
    if (this.map && this.observer)
      this.map.onBeforeBindObservable.remove(this.observer);
    this.map = undefined;
    this.observer = undefined;
  }
}

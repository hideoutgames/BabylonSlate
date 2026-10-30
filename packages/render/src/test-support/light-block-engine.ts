import { InternalTexture, InternalTextureSource, NullEngine } from "@babylonjs/core";

/**
 * Gives every NullEngine what a shipped Engine has for the light block, the one lighting path: uniform buffers (every
 * WebGL2 and WebGPU Engine has them; a plain NullEngine models a WebGL1 fallback no build runs), and what the block's
 * resources need that NullEngine cannot make: the emission texture array (uploaded at once), the shadow atlas's depth
 * texture and its tiles' scissored clears. The Babylon test project loads it first (`setupFiles`); a test that needs
 * another shape spies on its own Engine.
 */
export function installLightBlockNullEngine(): void {
  const prototype = NullEngine.prototype as NullEngine & Record<string, unknown>;
  Object.defineProperty(prototype, "supportsUniformBuffers", { configurable: true, get: () => true });
  prototype.createRawTexture2DArray = function (this: NullEngine) {
    const texture = new InternalTexture(this, InternalTextureSource.Raw2DArray);
    texture.isReady = true;
    return texture;
  };
  prototype.createDepthStencilTexture = function (this: NullEngine) {
    return new InternalTexture(this, InternalTextureSource.DepthStencil);
  };
  prototype.enableScissor = () => {};
  prototype.disableScissor = () => {};
}

installLightBlockNullEngine();

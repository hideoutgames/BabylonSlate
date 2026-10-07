import { Constants, InternalTexture, InternalTextureSource, type NullEngine } from "@babylonjs/core";

/**
 * Babylon 9.29 NullEngine has no FrameGraph allocation, MRT, depth-texture or
 * attachment-clear overrides, and omits the raw upload-ready flag the real
 * backends set. Supply only those absent GPU boundaries on one test engine; the
 * graph, tasks, wrappers and refcounts stay real.
 */
export function adaptNullEngineFrameGraph(engine: NullEngine): NullEngine {
  engine.buildTextureLayout = (enabled, backbuffer) =>
    backbuffer ? [0x0405] : enabled.map((value, index) => (value ? 0x8ce0 + index : 0));
  engine.bindAttachments = () => {};
  engine.clearAttachments = () => {};
  engine.restoreSingleAttachment = () => {};
  engine.restoreSingleAttachmentForRenderTarget = () => {};
  engine._createInternalTexture = (size, options) => {
    const creation = typeof options === "object" ? options : {};
    const wrapper = engine.createRenderTargetTexture(size, { ...creation, generateDepthBuffer: false });
    const texture = wrapper.texture!;
    texture.format = creation.format ?? Constants.TEXTUREFORMAT_RGBA;
    wrapper.dispose(true);
    return texture;
  };
  engine.createMultipleRenderTarget = (size) => engine._createHardwareRenderTargetWrapper(true, false, size);
  const upload = engine.createRawTexture.bind(engine);
  engine.createRawTexture = (...args) => {
    const texture = upload(...args);
    texture.isReady = true;
    return texture;
  };
  engine.getCaps().depthTextureExtension = true;
  engine.createDepthStencilTexture = (size, options) => {
    const texture = new InternalTexture(engine, InternalTextureSource.DepthStencil);
    const dimensions = typeof size === "number" ? { width: size, height: size } : size;
    texture.width = texture.baseWidth = dimensions.width;
    texture.height = texture.baseHeight = dimensions.height;
    texture.format = options.depthTextureFormat ?? Constants.TEXTUREFORMAT_DEPTH24;
    texture.samples = options.samples ?? 1;
    texture.isReady = true;
    engine.getLoadedTexturesCache().push(texture);
    return texture;
  };
  return engine;
}

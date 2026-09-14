import {
  Constants,
  EffectRenderer,
  EffectWrapper,
  ShaderStore,
  type AbstractEngine,
  type CubeTexture,
  type RenderTargetWrapper,
  type ThinEngine,
} from "@babylonjs/core";

const shaderName = "slateEnvironmentBaseRadiance";
for (const wgsl of [false, true]) {
  const uniforms = wgsl ? "uniforms." : "";
  const vec2 = wgsl ? "vec2f" : "vec2";
  const vec3 = wgsl ? "vec3f" : "vec3";
  const vec4 = wgsl ? "vec4f" : "vec4";
  const uv = wgsl ? "input.vUV" : "vUV";
  const store = ShaderStore.GetShadersStore(wgsl ? 1 : 0);
  store[`${shaderName}VertexShader`] = wgsl
    ? "attribute position: vec2f; varying vUV: vec2f; @vertex fn main(input: VertexInputs)->FragmentInputs { vertexOutputs.vUV=vertexInputs.position*0.5+vec2f(0.5); vertexOutputs.position=vec4f(vertexInputs.position,0.0,1.0); }"
    : "attribute vec2 position; varying vec2 vUV; void main() { vUV=position*0.5+0.5; gl_Position=vec4(position,0.0,1.0); }";
  const declarations = wgsl
    ? "varying vUV: vec2f; var sourceCube: texture_cube<f32>; var sourceCubeSampler: sampler; uniform axisX: vec3f; uniform axisY: vec3f; uniform axisZ: vec3f; uniform decode: vec4f;"
    : "#extension GL_EXT_shader_texture_lod : enable\nvarying vec2 vUV; uniform samplerCube sourceCube; uniform vec3 axisX,axisY,axisZ; uniform vec4 decode;";
  const local = (name: string, type: string) =>
    wgsl ? `var ${name}: ${type}` : `${type} ${name}`;
  const sample = wgsl
    ? "textureSampleLevel(sourceCube,sourceCubeSampler,direction,0.0)"
    : "textureCubeLodEXT(sourceCube,direction,0.0)";
  // A bounded stratified sample of base radiance, never an authored GGX mip.
  store[`${shaderName}PixelShader`] = `${declarations}
${wgsl ? "@fragment fn main(input: FragmentInputs)->FragmentOutputs" : "void main()"} {
${local("sum", vec3)}=${vec3}(0.0);
for (${wgsl ? "var y: i32=0" : "int y=0"};y<4;y++) {
for (${wgsl ? "var x: i32=0" : "int x=0"};x<4;x++) {
${local("uv", vec2)}=${uv}+(${vec2}(${wgsl ? "f32(x),f32(y)" : "float(x),float(y)"})-${vec2}(1.5))*${uniforms}decode.w*0.25;
${local("direction", vec3)}=${uniforms}axisZ+${uniforms}axisX*(uv.x*2.0-1.0)+${uniforms}axisY*(uv.y*2.0-1.0);
${local("pixel", vec4)}=${sample};
${local("color", vec3)}=pixel.rgb;
if (${uniforms}decode.x>0.5 || ${uniforms}decode.y>0.5) {
if (${uniforms}decode.z>0.5) { color=mix(color/12.92,pow((color+${vec3}(0.055))/1.055,${vec3}(2.4)),step(${vec3}(0.04045),color)); }
else { color=pow(color,${vec3}(2.2)); }
}
if (${uniforms}decode.x>0.5) { color=color/pixel.a; }
sum+=color;
}}
${wgsl ? "fragmentOutputs.color" : "gl_FragColor"}=${vec4}(sum/16.0,1.0);
}`;
}

const axes = [
  [
    [0, 0, -1],
    [0, -1, 0],
    [1, 0, 0],
  ],
  [
    [0, 0, 1],
    [0, -1, 0],
    [-1, 0, 0],
  ],
  [
    [1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [1, 0, 0],
    [0, 0, -1],
    [0, -1, 0],
  ],
  [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, 1],
  ],
  [
    [-1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ],
] as const;

async function settledPixels(
  reads: Promise<ArrayBufferView | null>[],
): Promise<ArrayBufferView[]> {
  const results = await Promise.allSettled(reads);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    if (!result.value)
      throw new Error("Environment base radiance readback returned no pixels.");
    return result.value;
  });
}

/** Read a bounded base-radiance grid, keeping temporary GPU storage alive through every read. */
export async function readEnvironmentBaseRadiance(
  source: CubeTexture,
  current: () => boolean,
): Promise<{ size: number; faces: ArrayBufferView[]; linear: boolean } | null> {
  const width = source.getSize().width;
  if (width <= 32) {
    const faces = await settledPixels(
      axes.map((_, face) =>
        Promise.resolve().then(() =>
          source.readPixels(face, 0, undefined, false),
        ),
      ),
    );
    return { size: width, faces, linear: false };
  }
  const engine = source.getInternalTexture()!.getEngine();
  const caps = engine.getCaps();
  if (!caps.textureFloatRender && !caps.textureHalfFloatRender)
    throw new Error(
      "Missing environment irradiance requires a float or half-float render target.",
    );
  if (!engine.isWebGPU && !caps.textureLOD)
    throw new Error(
      "Missing environment irradiance requires explicit base mip sampling.",
    );
  const effect = new EffectWrapper({
    engine,
    name: shaderName,
    vertexShader: shaderName,
    fragmentShader: shaderName,
    useShaderStore: true,
    shaderLanguage: engine.isWebGPU ? 1 : 0,
    uniformNames: ["axisX", "axisY", "axisZ", "decode"],
    samplerNames: ["sourceCube"],
    blockCompilation: true,
  });
  let renderer: EffectRenderer | undefined;
  let target: RenderTargetWrapper | undefined;
  const reads: Promise<ArrayBufferView | null>[] = [];
  try {
    await new Promise<void>((resolve, reject) =>
      effect.updateEffect(
        null,
        null,
        null,
        undefined,
        () => resolve(),
        (_effect, error) => reject(new Error(error)),
      ),
    );
    if (!current()) return null;
    withDrawingState(engine, () => {
      renderer = new EffectRenderer(engine);
      target = engine.createRenderTargetTexture(32, {
        type: caps.textureFloatRender
          ? Constants.TEXTURETYPE_FLOAT
          : Constants.TEXTURETYPE_HALF_FLOAT,
        format: Constants.TEXTUREFORMAT_RGBA,
        generateMipMaps: false,
        generateDepthBuffer: false,
        generateStencilBuffer: false,
        samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
        label: "Environment base radiance readback",
      });
      engine.bindFramebuffer(target);
      renderer.setViewport();
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setColorWrite(true);
      engine.setDepthWrite(false);
      renderer.applyEffectWrapper(effect);
      effect.effect.setTexture("sourceCube", source);
      effect.effect.setFloat4(
        "decode",
        source.isRGBD ? 1 : 0,
        source.gammaSpace ? 1 : 0,
        engine.useExactSrgbConversions ? 1 : 0,
        1 / 32,
      );
      for (const [x, y, z] of axes) {
        effect.effect.setFloat3("axisX", x[0], x[1], x[2]);
        effect.effect.setFloat3("axisY", y[0], y[1], y[2]);
        effect.effect.setFloat3("axisZ", z[0], z[1], z[2]);
        renderer.draw();
        // Pinned BaseTexture.readPixels primitive: captures a 2D target and
        // restores its framebuffer synchronously before a WebGPU read resolves.
        reads.push(
          engine._readTexturePixels(target.texture!, 32, 32, -1, 0, null, true),
        );
      }
    });
    const faces = await settledPixels(reads);
    return current() ? { size: 32, faces, linear: true } : null;
  } finally {
    // A later draw/read may throw after earlier reads have already been submitted.
    await Promise.allSettled(reads);
    target?.dispose();
    renderer?.dispose();
    effect.dispose();
  }
}

/** Pinned 9.20 adapter: preserve exact framebuffer attachment and render state. */
function withDrawingState<T>(engine: AbstractEngine, draw: () => T): T {
  const viewport = engine.currentViewport && { ...engine.currentViewport };
  const width = engine.getRenderWidth(),
    height = engine.getRenderHeight();
  const target = engine._currentRenderTarget;
  const webgl = engine.isWebGPU ? null : (engine as ThinEngine);
  const framebuffer = webgl?._currentFramebuffer;
  const webgpu = engine as AbstractEngine & {
    _rttRenderPassWrapper?: {
      colorAttachmentViewDescriptor?: {
        baseArrayLayer?: number;
        baseMipLevel?: number;
      };
    };
  };
  const attachment =
    webgpu._rttRenderPassWrapper?.colorAttachmentViewDescriptor;
  const layer = attachment?.baseArrayLayer ?? 0,
    mip = attachment?.baseMipLevel ?? 0;
  const depth = engine.depthCullingState;
  const savedDepth = {
    depthTest: depth.depthTest,
    depthMask: depth.depthMask,
    depthFunc: depth.depthFunc,
    cull: depth.cull,
    cullFace: depth.cullFace,
    frontFace: depth.frontFace,
    zOffset: depth.zOffset,
    zOffsetUnits: depth.zOffsetUnits,
  };
  const stencil = engine.stencilState.stencilTest;
  const stencilMaterial = engine.stencilStateComposer.stencilMaterial;
  const alpha = engine.getAlphaMode(),
    color = engine.getColorWrite();
  try {
    return draw();
  } finally {
    if (webgl) {
      webgl._bindUnboundFramebuffer(framebuffer ?? null);
      engine._currentRenderTarget = target;
    } else if (target) {
      engine.bindFramebuffer(
        target,
        target.isCube ? layer % 6 : 0,
        width,
        height,
        true,
        mip,
        target.isCube ? Math.floor(layer / 6) : layer,
      );
    } else engine.restoreDefaultFramebuffer();
    engine.setViewport(
      viewport ?? { x: 0, y: 0, width: 1, height: 1 },
      width,
      height,
    );
    engine.setAlphaMode(alpha);
    engine.setColorWrite(color);
    Object.assign(depth, savedDepth);
    engine.stencilState.stencilTest = stencil;
    engine.stencilStateComposer.stencilMaterial = stencilMaterial;
    engine.wipeCaches();
  }
}

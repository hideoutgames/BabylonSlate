import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { retainEngineEffect } from "./effect-bridge";
import { withDrawingState } from "./engine-drawing-state";

const shaderName = "hapticEnvironmentBaseRadiance";
{
  const vec2 = "vec2";
  const vec3 = "vec3";
  const vec4 = "vec4";
  const uv = "vUV";
  const store = ShaderStore.GetShadersStore(0);
  store[`${shaderName}VertexShader`] =
    "attribute vec2 position; varying vec2 vUV; void main() { vUV=position*0.5+0.5; gl_Position=vec4(position,0.0,1.0); }";
  const declarations =
    "#extension GL_EXT_shader_texture_lod : enable\nvarying vec2 vUV; uniform samplerCube sourceCube; uniform vec3 axisX,axisY,axisZ; uniform vec4 decode;";
  const local = (name: string, type: string) =>
    `${type} ${name}`;
  const sample =
    "textureCubeLodEXT(sourceCube,direction,0.0)";
  // A bounded stratified sample of base radiance, never an authored GGX mip.
  store[`${shaderName}PixelShader`] = `${declarations}
void main() {
${local("sum", vec3)}=${vec3}(0.0);
for (int y=0;y<4;y++) {
for (int x=0;x<4;x++) {
${local("uv", vec2)}=${uv}+(${vec2}(float(x),float(y))-${vec2}(1.5))*decode.w*0.25;
${local("direction", vec3)}=axisZ+axisX*(uv.x*2.0-1.0)+axisY*(uv.y*2.0-1.0);
${local("pixel", vec4)}=${sample};
${local("color", vec3)}=pixel.rgb;
if (decode.x>0.5 || decode.y>0.5) {
if (decode.z>0.5) { color=mix(color/12.92,pow((color+${vec3}(0.055))/1.055,${vec3}(2.4)),step(${vec3}(0.04045),color)); }
else { color=pow(color,${vec3}(2.2)); }
}
if (decode.x>0.5) { color=color/pixel.a; }
sum+=color;
}}
gl_FragColor=${vec4}(sum/16.0,1.0);
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

/**
 * Reads the bound `target` (32 × 32 RGBA float) without stalling the main thread where the device allows: WebGL2
 * copies into a pixel buffer behind a fence (Babylon's `_readPixelsAsync`), which resolves once the GPU reaches it,
 * where a plain `readPixels` waits for every queued draw and shader link first. Other engines read synchronously.
 */
function readBoundTarget(engine: AbstractEngine, target: RenderTargetWrapper): Promise<ArrayBufferView | null> {
  const gl = (engine as Engine)._gl as WebGL2RenderingContext | undefined;
  if ((engine as Engine).webGLVersion >= 2 && typeof gl?.fenceSync === "function") {
    const read = (engine as Engine)._readPixelsAsync(0, 0, 32, 32, gl.RGBA, gl.FLOAT, new Float32Array(32 * 32 * 4));
    if (read) return read;
  }
  // Pinned BaseTexture.readPixels primitive: captures a 2D target and
  // restores its framebuffer synchronously.
  return engine._readTexturePixels(target.texture!, 32, 32, -1, 0, null, true);
}

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
  if (!caps.textureLOD)
    throw new Error(
      "Missing environment irradiance requires explicit base mip sampling.",
    );
  const effect = new EffectWrapper({
    engine,
    name: shaderName,
    vertexShader: shaderName,
    fragmentShader: shaderName,
    useShaderStore: true,
    shaderLanguage: 0,
    uniformNames: ["axisX", "axisY", "axisZ", "decode"],
    samplerNames: ["sourceCube"],
    blockCompilation: true,
  });
  let renderer: EffectRenderer | undefined;
  let target: RenderTargetWrapper | undefined;
  const reads: Promise<ArrayBufferView | null>[] = [];
  try {
    effect.updateEffect();
    // Waits on the Effect itself: Babylon calls the `onCompiled` and `onError` a request passes only for the Effect it
    // creates, never for one its cache returns (an Effect the Play keep holds, or one a concurrent read compiled).
    const compiled = effect.effect;
    await new Promise<void>((resolve, reject) => {
      const failed = () => compiled.getCompilationError() && compiled.allFallbacksProcessed();
      if (failed()) {
        reject(new Error(compiled.getCompilationError()));
        return;
      }
      const error = compiled.onErrorObservable.add(() => {
        if (failed()) reject(new Error(compiled.getCompilationError()));
      });
      compiled.executeWhenCompiled(() => {
        compiled.onErrorObservable.remove(error);
        resolve();
      });
    });
    // Retain the compiled base-radiance shader on the Engine keep so Scene switches reuse it without re-linking.
    retainEngineEffect(engine, compiled);
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
        reads.push(readBoundTarget(engine, target!));
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

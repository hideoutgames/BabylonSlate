/** Test-build-only readback of the FFT ocean detail band, compared texel by texel with the CPU reference. */
import {
  Constants, EffectRenderer, EffectWrapper, Engine, FreeCamera, HemisphericLight, Scene, ShaderStore, Vector3,
  type AbstractEngine, type BaseTexture, type PBRMaterial,
} from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody, waterWaveSet, type WaterDefinition } from "@babylonslate/core";
import {
  createAppWebGpuEngine, createWaterMesh, setSceneRenderSettings, setSceneWaterTime, waterFftCycle, waterFftDiagnostics, waterFftForSurface,
  waterFftInitialSpectrum, waterFftLayout, waterFftSynthesize,
} from "@babylonslate/render";

const SIZE = 64;
const COPY = "slateWaterFftProofCopy";
// Columns [0, layers·N) fetch each layer's texels; columns [layers·N, 2·layers·N) sample the same texel centres one
// period away through the material-style bilinear REPEAT sampler.
ShaderStore.ShadersStore[`${COPY}VertexShader`] = "attribute vec2 position;\nvoid main(void) {\ngl_Position = vec4(position, 0.0, 1.0);\n}";
ShaderStore.ShadersStoreWGSL[`${COPY}VertexShader`] = "attribute position: vec2f;\n@vertex\nfn main(input: VertexInputs) -> FragmentInputs {\nvertexOutputs.position = vec4f(vertexInputs.position, 0.0, 1.0);\n}";
ShaderStore.ShadersStore[`${COPY}PixelShader`] = `precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray fftOutput;
uniform vec4 copyParams;
void main(void) {
ivec2 p = ivec2(gl_FragCoord.xy);
int size = int(copyParams.x);
int layers = int(copyParams.y);
int column = p.x / size;
int layer = column - (column / layers) * layers;
int x = p.x - column * size;
vec2 uv = vec2((float(x) + 0.5) / copyParams.x + 1.0, (float(p.y) + 0.5) / copyParams.x - 2.0);
gl_FragColor = column < layers ? texelFetch(fftOutput, ivec3(x, p.y, layer), 0) : textureLod(fftOutput, vec3(uv, float(layer)), 0.0);
}`;
ShaderStore.ShadersStoreWGSL[`${COPY}PixelShader`] = `var fftOutputSampler: sampler;
var fftOutput: texture_2d_array<f32>;
uniform copyParams: vec4f;
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
let p = vec2i(fragmentInputs.position.xy);
let size = i32(uniforms.copyParams.x);
let layers = i32(uniforms.copyParams.y);
let column = p.x / size;
let layer = column - (column / layers) * layers;
let x = p.x - column * size;
let uv = vec2f((f32(x) + 0.5) / uniforms.copyParams.x + 1.0, (f32(p.y) + 0.5) / uniforms.copyParams.x - 2.0);
let fetched = textureLoad(fftOutput, vec2i(x, p.y), layer, 0);
let sampled = textureSampleLevel(fftOutput, fftOutputSampler, uv, layer, 0.0);
fragmentOutputs.color = select(sampled, fetched, column < layers);
}`;

/** Every texel of every output layer, fetched and sampled, as float32 RGBA rows from texel row 0. */
async function readLayers(engine: AbstractEngine, texture: BaseTexture, layers: number): Promise<Float32Array> {
  const copy = new EffectWrapper({
    engine, name: COPY, vertexShader: COPY, fragmentShader: COPY, useShaderStore: true, shaderLanguage: engine.isWebGPU ? 1 : 0,
    uniformNames: ["copyParams"], samplerNames: ["fftOutput"],
  });
  const renderer = new EffectRenderer(engine);
  const target = engine.createRenderTargetTexture({ width: 2 * layers * SIZE, height: SIZE }, {
    type: Constants.TEXTURETYPE_FLOAT, format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: "Water FFT proof copy",
  });
  try {
    for (let attempt = 0; !copy.isReady(); attempt++) {
      if (attempt > 300) throw new Error("The FFT proof copy shader never compiled.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    engine.beginFrame();
    try {
      engine.bindFramebuffer(target, 0, undefined, undefined, true);
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      renderer.applyEffectWrapper(copy);
      copy.effect.setTexture("fftOutput", texture);
      copy.effect.setFloat4("copyParams", SIZE, layers, 0, 0);
      renderer.draw();
      engine.unBindFramebuffer(target);
    } finally { engine.endFrame(); }
    const pixels = await engine._readTexturePixels(target.texture!, 2 * layers * SIZE, SIZE, -1, 0, null, true, false);
    return pixels instanceof Float32Array ? pixels : new Float32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
  } finally {
    target.dispose();
    renderer.dispose();
    copy.dispose();
  }
}

/** Largest |GPU − CPU| and largest |CPU| per output channel, for the fetched and the sampled copy. */
function compare(pixels: Float32Array, reference: Float64Array[]) {
  const layers = reference.length, width = 2 * layers * SIZE;
  return reference.flatMap((expected, layer) => [0, 1, 2, 3].map((channel) => {
    let magnitude = 0, fetchError = 0, sampledError = 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const value = expected[(y * SIZE + x) * 4 + channel]!;
      const fetched = pixels[(y * width + layer * SIZE + x) * 4 + channel]!;
      const sampled = pixels[(y * width + (layers + layer) * SIZE + x) * 4 + channel]!;
      magnitude = Math.max(magnitude, Math.abs(value));
      fetchError = Math.max(fetchError, Math.abs(fetched - value));
      sampledError = Math.max(sampledError, Math.abs(sampled - value));
    }
    return { layer, channel, magnitude, fetchError, sampledError };
  }));
}

export async function runWaterFftProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true,
  });
  const scene = new Scene(engine);
  try {
    // One 64² cascade: the smallest band, enough to prove every pass and the output packing on this backend.
    setSceneRenderSettings(scene, { quality: normalizeRenderingQuality({ water: { fft: true, fftSize: SIZE, fftCascades: 1 } }) });
    new HemisphericLight("light", Vector3.Up(), scene);
    const camera = new FreeCamera("camera", new Vector3(0, 12, -18), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    const mesh = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 24, length: 24, resolution: 16 }), {
      ...createDefaultWaterDefinition(), waveSeed: 7, waveDirection: 30, waveSpread: 0.4,
    });
    // The definition the built-in material holds: what a water material passes to waterFftForSurface.
    const plugin = (mesh.material as PBRMaterial).pluginManager!.getPlugin("SlateWater") as unknown as { water: WaterDefinition };
    const water = plugin.water;
    const set = waterWaveSet(water), layout = waterFftLayout(set, SIZE, 1), spectrum = waterFftInitialSpectrum(set, layout);
    const samples = [];
    let frames = 0;
    for (const time of [3.7, 41.3]) {
      setSceneWaterTime(scene, time);
      // Non-blocking readiness: frames render analytic water until the band has run for this time.
      for (;;) {
        if (++frames > 400) throw new Error("The FFT band never became ready.");
        engine.beginFrame();
        try { scene.render(); } finally { engine.endFrame(); }
        const result = waterFftForSurface(scene, water);
        if (result?.ready && waterFftDiagnostics(scene).simulations[0]?.time === time) break;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      const result = waterFftForSurface(scene, water)!;
      const pixels = await readLayers(engine, result.texture, 2);
      // The GPU receives the cycle as a float32 uniform.
      const reference = waterFftSynthesize(spectrum, layout, Math.fround(waterFftCycle(time)));
      samples.push({ time, channels: compare(pixels, reference) });
    }
    const result = waterFftForSurface(scene, water)!;
    const internal = result.texture.getInternalTexture()!;
    return {
      backend, frames, samples,
      texture: {
        is2DArray: internal.is2DArray, layers: internal.depth, width: internal.width, height: internal.height, type: internal.type,
        format: internal.format, wrapU: result.texture.wrapU, wrapV: result.texture.wrapV,
      },
      patchSizes: result.patchSizes, amplitudeGain: result.amplitudeGain, cascades: result.cascades,
      diagnostics: waterFftDiagnostics(scene),
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}

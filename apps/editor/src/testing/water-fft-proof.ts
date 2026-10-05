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
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";

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
async function readLayers(engine: AbstractEngine, texture: BaseTexture, size: number, layers: number): Promise<Float32Array> {
  const copy = new EffectWrapper({
    engine, name: COPY, vertexShader: COPY, fragmentShader: COPY, useShaderStore: true, shaderLanguage: engine.isWebGPU ? 1 : 0,
    uniformNames: ["copyParams"], samplerNames: ["fftOutput"],
  });
  const renderer = new EffectRenderer(engine);
  const target = engine.createRenderTargetTexture({ width: 2 * layers * size, height: size }, {
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
      copy.effect.setFloat4("copyParams", size, layers, 0, 0);
      renderer.draw();
      engine.unBindFramebuffer(target);
    } finally { engine.endFrame(); }
    const pixels = await engine._readTexturePixels(target.texture!, 2 * layers * size, size, -1, 0, null, true, false);
    return pixels instanceof Float32Array ? pixels : new Float32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
  } finally {
    target.dispose();
    renderer.dispose();
    copy.dispose();
  }
}

/** Largest |GPU − CPU| and largest |CPU| per output channel, for the fetched and the sampled copy. */
function compare(pixels: Float32Array, reference: Float64Array[], size: number) {
  const layers = reference.length, width = 2 * layers * size;
  return reference.flatMap((expected, layer) => [0, 1, 2, 3].map((channel) => {
    let magnitude = 0, fetchError = 0, sampledError = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const value = expected[(y * size + x) * 4 + channel]!;
      const fetched = pixels[(y * width + layer * size + x) * 4 + channel]!;
      const sampled = pixels[(y * width + (layers + layer) * size + x) * 4 + channel]!;
      magnitude = Math.max(magnitude, Math.abs(value));
      fetchError = Math.max(fetchError, Math.abs(fetched - value));
      sampledError = Math.max(sampledError, Math.abs(sampled - value));
    }
    return { layer, channel, magnitude, fetchError, sampledError };
  }));
}

export interface WaterFftProofOptions {
  /** FFT Size and FFT Cascades: 64²×1 is the smallest band; 128²×2 and 256²×3 are the High and Ultra presets. */
  size?: number;
  cascades?: number;
  /** Render through `Scene.render` (classic) or the production forward FrameGraph that Play uses. */
  path?: "classic" | "frameGraph";
}

export async function runWaterFftProof(backend: "webgl2" | "webgpu", options: WaterFftProofOptions = {}) {
  const { size = 64, cascades = 1, path = "classic" } = options;
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true,
  });
  const scene = new Scene(engine);
  try {
    setSceneRenderSettings(scene, { quality: normalizeRenderingQuality({ water: { fft: true, fftSize: size, fftCascades: cascades } }) });
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
    const set = waterWaveSet(water), layout = waterFftLayout(set, size, cascades), spectrum = waterFftInitialSpectrum(set, layout);
    const graph = path === "frameGraph" ? new ForwardSceneFrameGraph(scene) : null;
    const renderPaths = new Set<string>();
    const render = async () => {
      if (!graph) {
        engine.beginFrame();
        try { scene.render(); } finally { engine.endFrame(); }
        renderPaths.add("classic");
        return;
      }
      const prepared = await graph.prepare(camera);
      if (prepared.path !== "frameGraph") throw new Error(`The forward FrameGraph was unavailable: ${JSON.stringify(prepared)}`);
      engine.beginFrame();
      try {
        // `rendered: false` on the graph path only asks for a retry after a readiness change mid-frame; the frame
        // (and the water before-render observer) still ran through the graph.
        renderPaths.add(graph.render(camera).path);
      } finally { engine.endFrame(); }
    };
    const samples = [];
    let frames = 0;
    for (const time of [3.7, 41.3]) {
      setSceneWaterTime(scene, time);
      // Non-blocking readiness: frames render analytic water while the spectrum is drawn in steps and the band runs.
      // Asking for the band after each frame is the material's demand, as the water shader's bind will.
      for (;;) {
        if (++frames > 600) throw new Error("The FFT band never became ready.");
        await render();
        const result = waterFftForSurface(scene, water);
        if (result?.ready && waterFftDiagnostics(scene).simulations[0]?.time === time) break;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      const result = waterFftForSurface(scene, water)!;
      const pixels = await readLayers(engine, result.texture, size, 2 * cascades);
      // The GPU receives the cycle as a float32 uniform.
      const reference = waterFftSynthesize(spectrum, layout, Math.fround(waterFftCycle(time, layout.timeScale)));
      samples.push({ time, channels: compare(pixels, reference, size) });
    }
    const result = waterFftForSurface(scene, water)!;
    const internal = result.texture.getInternalTexture()!;
    graph?.dispose();
    return {
      backend, size, cascades, path, renderPaths: [...renderPaths], frames, samples,
      texture: {
        is2DArray: internal.is2DArray, layers: internal.depth, width: internal.width, height: internal.height, type: internal.type,
        format: internal.format, wrapU: result.texture.wrapU, wrapV: result.texture.wrapV,
      },
      band: { cascades: result.cascades, patchSizes: result.patchSizes, amplitudeGain: result.amplitudeGain },
      expectedPatchSizes: layout.patchSizes,
      diagnostics: waterFftDiagnostics(scene),
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}

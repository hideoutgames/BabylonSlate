/**
 * The WebGPU twin of `babylon-registrations.ts`: Babylon side effects only a WebGPU Engine needs. `webgpu-engine.ts`
 * loads it, and that module loads only on the WebGPU path (`webgpu-on-demand.ts`), so a WebGL2 session never fetches
 * Babylon's WebGPU engine or these WGSL shaders. Modules that run for both backends import the GLSL half themselves and
 * never import `@babylonjs/core/ShadersWGSL/*` or `@babylonjs/core/Engines/WebGPU/*` (render.md).
 */
import { WebGPUCacheRenderPipeline } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline";
import { RegisterEnginesWebGPUExtensionsEngineAlphaToCoverage } from "@babylonjs/core/Engines/WebGPU/Extensions/engine.alphaToCoverage.pure";
import { provideWebGpuPipelineStatistics, type WebGpuPipelineStatistics } from "./webgpu-on-demand";
// Multiple render targets (babylon-registrations.ts registers the WebGL2 half).
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
// GPU particles: compute shaders and the compute-shader particle system (particle-system-factory.ts).
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Particles/computeShaderParticleSystem";
// Custom particle effects bypass GPUParticleSystem's default effect initializer, which normally imports its WGSL vertex
// shader before requesting compilation (node-material-particles.ts).
import "@babylonjs/core/ShadersWGSL/gpuRenderParticles.vertex";
// Includes and stages Haptic's own blocks and passes reference, which no Babylon material requests for them: scene fog
// (scene-fog-block.ts), environment and mirror sampling (environment-sample-block.ts, mirror-reflection-block.ts), the
// authored shadow output (authored-shadow-output.ts), the water scene copy (water-scene-copy.ts), spatial effects
// (spatial-effects.ts) and the shared outline mask (shared-outline-shaders.ts).
import "@babylonjs/core/ShadersWGSL/ShadersInclude/fogFragmentDeclaration";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/helperFunctions";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexExtraDeclaration";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexNormalBias";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexMetric";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapFragmentExtraDeclaration";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapFragmentSoftTransparentShadow";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapFragment";
import "@babylonjs/core/ShadersWGSL/postprocess.vertex";
import "@babylonjs/core/ShadersWGSL/selection.fragment";
// Stock stages whose WGSL text Haptic rewrites (`registeredWgsl`): the native lattice deformer
// (lattice-deformer-native.ts) and the shared outline mask (shared-outline-shaders.ts).
import "@babylonjs/core/ShadersWGSL/default.vertex";
import "@babylonjs/core/ShadersWGSL/pbr.vertex";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/bumpFragment";
import "@babylonjs/core/ShadersWGSL/selection.vertex";

// setAlphaToCoverage on WebGPU (alpha-to-coverage.ts registers the WebGL2 half when a Material first uses it).
RegisterEnginesWebGPUExtensionsEngineAlphaToCoverage();
// Read by create-engine.ts and written by webgpu-pipeline-deferral.ts, which run for both backends.
provideWebGpuPipelineStatistics(WebGPUCacheRenderPipeline as unknown as WebGpuPipelineStatistics);

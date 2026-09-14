import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide, FloatType, LinearSRGBColorSpace, Mesh,
  MeshPhysicalMaterial, NearestFilter, NoToneMapping, OrthographicCamera, PerspectiveCamera, PointLight,
  RGBAFormat, Scene, ShaderMaterial, WebGLRenderer,
} from "three";
import { WebGLPathTracer } from "three-gpu-pathtracer";
import { rasterizeBakeReceivers, validateBakePrototypeInput, type BakePrototypeInput } from "./bake-prototype-input";
import { patchBakePrototypeShader } from "./bake-prototype-shader";
import { readBakePixels, waitForBakeGpu } from "./bake-prototype-gpu";

export type { BakePrototypeInput, BakePrototypeMesh, BakePrototypeColor } from "./bake-prototype-input";

export interface BakePrototypeProgress {
  phase: "preparing" | "building" | "compiling" | "sampling" | "readback" | "disposing";
  samples: number;
  totalSamples: number;
}

export interface BakePrototypeDisposal {
  contextReleased: boolean;
  texturesBeforeDisposal: number;
  geometriesBeforeDisposal: number;
}

export interface BakePrototypeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BakePrototypeProgress) => void;
  onDisposed?: (result: BakePrototypeDisposal) => void;
}

export interface BakePrototypeResult {
  /** Bottom row first, raw linear RGB irradiance; alpha is receiver coverage. No denoise/padding. */
  irradiance: Float32Array;
  size: number;
  samples: number;
  coveredTexels: number;
  estimatedWorkingBytes: number;
  elapsedMs: number;
}

type OwnedDisposable = { dispose(): void };
type InternalTracer = OwnedDisposable & {
  material: ShaderMaterial;
  stableNoise: boolean;
  alpha: boolean;
  isCompiling: boolean;
  _compileFunction: () => void;
};
type TracerInternals = {
  _pathTracer: InternalTracer;
  _lowResPathTracer: InternalTracer;
  _generator: { geometry: BufferGeometry };
};

function internals(tracer: WebGLPathTracer): TracerInternals {
  const value = tracer as unknown as Partial<TracerInternals>;
  if (!(value._pathTracer?.material instanceof ShaderMaterial)
    || !(value._lowResPathTracer?.material instanceof ShaderMaterial)
    || !(value._generator?.geometry instanceof BufferGeometry)
    || typeof value._pathTracer._compileFunction !== "function"
    || typeof value._lowResPathTracer._compileFunction !== "function") {
    throw new Error("Unsupported three-gpu-pathtracer 0.0.24 resource layout");
  }
  return value as TracerInternals;
}

function ownCompilation(tracer: InternalTracer) {
  // Three's compileAsync installs an uncancellable timer which dereferences disposed
  // material programs. This isolated adapter polls owned GL programs instead.
  const material = tracer.material as unknown as {
    removeEventListener(type: string, listener: () => void): void;
  };
  material.removeEventListener("recompilation", tracer._compileFunction);
}

function texture(data: Float32Array, width: number, height: number) {
  const result = new DataTexture(data, width, height, RGBAFormat, FloatType);
  result.minFilter = result.magFilter = NearestFilter;
  result.generateMipmaps = false;
  result.needsUpdate = true;
  return result;
}

function disposeMaterialResources(material: ShaderMaterial, release: (resource: OwnedDisposable) => void) {
  for (const uniform of Object.values(material.uniforms)) {
    const value: unknown = uniform.value;
    if (!value || typeof value !== "object") continue;
    if ("dispose" in value && typeof value.dispose === "function") release(value as OwnedDisposable);
    // LightsInfoUniformStruct owns its texture but has no dispose method.
    if ("tex" in value && value.tex instanceof DataTexture) release(value.tex);
  }
  release(material);
}

let active = false;

/**
 * Bounded provider selection proof, separate from the viewport and persisted bake APIs.
 * One job owns its WebGL2 context; completion, failure and abort all release that context.
 */
export async function bakeLightingPrototype(input: BakePrototypeInput, options: BakePrototypeOptions = {}): Promise<BakePrototypeResult> {
  if (active) throw new Error("A prototype bake is already running");
  active = true;
  const started = performance.now();
  let yieldedAt = started;
  const check = () => {
    if (options.signal?.aborted) throw new DOMException("Bake cancelled", "AbortError");
    if (performance.now() - started > 120_000) throw new Error("Prototype bake exceeded its two-minute deadline");
  };
  const checkpoint = async (force = false) => {
    check();
    if (force || performance.now() - yieldedAt >= 4) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      yieldedAt = performance.now();
      check();
    }
  };
  const progress = (phase: BakePrototypeProgress["phase"], samples = 0) => {
    options.onProgress?.({ phase, samples, totalSamples: input.samples });
    check();
  };
  let renderer: WebGLRenderer | undefined;
  let context: WebGL2RenderingContext | null = null;
  let tracer: WebGLPathTracer | undefined;
  const owned: OwnedDisposable[] = [];
  let failure: unknown;
  let failed = false;
  let result: BakePrototypeResult | undefined;
  try {
    check();
    validateBakePrototypeInput(input);
    // Callers retain ownership. Snapshot before the first yield so subsequent edits
    // cannot change the admitted geometry, light closure, or requested work limits.
    input = {
      ...input,
      meshes: input.meshes.map((mesh) => ({
        positions: mesh.positions.slice(), uv2: mesh.uv2?.slice(),
        material: { ...mesh.material, albedo: [...mesh.material.albedo], emission: mesh.material.emission && [...mesh.material.emission] },
      })),
      lights: input.lights.map((light) => ({ ...light, position: [...light.position], color: [...light.color] })),
      environment: input.environment && [...input.environment],
    };
    progress("preparing");
    await checkpoint(true);
    const atlas = await rasterizeBakeReceivers(input, checkpoint);
    check();
    const canvas = document.createElement("canvas");
    context = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!context || !context.getExtension("EXT_color_buffer_float") || !context.getExtension("WEBGL_lose_context")) {
      throw new Error("Prototype baking requires WebGL2 float render targets and an owned releasable context");
    }
    renderer = new WebGLRenderer({ canvas, context, antialias: false, alpha: false });
    renderer.setSize(input.size, input.size, false);
    renderer.toneMapping = NoToneMapping;
    renderer.outputColorSpace = LinearSRGBColorSpace;
    let shaderFailure: Error | undefined;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      // @types/three 0.181 types this as its wrapper; Three passes the native handle.
      shaderFailure = new Error(`Bake shader failed: ${gl.getProgramInfoLog(program as unknown as WebGLProgram)} ${gl.getShaderInfoLog(vertex)} ${gl.getShaderInfoLog(fragment)}`);
    };
    const scene = new Scene();
    for (const mesh of input.meshes) {
      await checkpoint();
      const geometry = new BufferGeometry();
      owned.push(geometry);
      geometry.setAttribute("position", new BufferAttribute(mesh.positions.slice(), 3));
      geometry.computeVertexNormals();
      // Later bounces retain the upstream material closure. The restricted proxy has
      // no specular reflection, metallic/transmission, texture, or animated inputs.
      const material = new MeshPhysicalMaterial({
        color: new Color(...mesh.material.albedo),
        emissive: new Color(...(mesh.material.emission ?? [0, 0, 0])),
        roughness: 1, metalness: 0, specularIntensity: 0, side: DoubleSide,
      });
      owned.push(material);
      scene.add(new Mesh(geometry, material));
    }
    for (const light of input.lights) {
      const native = new PointLight(new Color(...light.color), light.intensity, 0, 2);
      native.position.fromArray(light.position);
      scene.add(native);
    }
    if (input.environment) {
      // The native inverse-CDF textures approximate a continuous distribution;
      // tiny maps quantize their row lookup even when radiance is constant.
      const data = new Float32Array(128 * 64 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([...input.environment, 1], i);
      const environment = texture(data, 128, 64);
      owned.push(environment);
      scene.environment = environment;
    }
    const positions = texture(atlas.positions, input.size, input.size);
    const normals = texture(atlas.normals, input.size, input.size);
    owned.push(positions, normals);
    progress("building");
    await checkpoint(true);
    tracer = new WebGLPathTracer(renderer);
    const native = internals(tracer);
    ownCompilation(native._pathTracer);
    ownCompilation(native._lowResPathTracer);
    const material = native._pathTracer.material;
    material.fragmentShader = patchBakePrototypeShader(material.fragmentShader);
    material.uniforms.bakePositions = { value: positions };
    material.uniforms.bakeNormals = { value: normals };
    material.uniforms.bakeMode = { value: ["full", "direct", "indirect"].indexOf(input.mode) };
    // PCG depends only on pixel/sample seeds, unlike newly-created blue-noise maps.
    material.defines.RANDOM_TYPE = 0;
    material.defines.FEATURE_DOF = 0;
    material.defines.FEATURE_FOG = 0;
    native._pathTracer.stableNoise = true;
    // Coverage requires manual alpha accumulation on every tile. The facade derives
    // alpha from backgroundAlpha after each update, so both must agree before drawing.
    material.uniforms.backgroundAlpha.value = 0;
    native._pathTracer.alpha = true;
    native._lowResPathTracer.alpha = true;
    tracer.renderDelay = 0;
    tracer.renderToCanvas = false;
    tracer.rasterizeScene = false;
    tracer.bounces = input.bounces;
    tracer.transmissiveBounces = 0;
    tracer.textureSize.set(1, 1);
    tracer.tiles.set(Math.ceil(input.size / 32), Math.ceil(input.size / 32));
    // Scene/BVH building is indivisible upstream, bounded here to 512 triangles.
    tracer.setScene(scene, new PerspectiveCamera());
    material.needsUpdate = true;
    const compileGeometry = new BufferGeometry();
    owned.push(compileGeometry);
    compileGeometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    compileGeometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const previousTarget = renderer.getRenderTarget();
    try {
      // Compile the same linear target variant that sampling actually uses.
      renderer.setRenderTarget(tracer.target);
      renderer.compile(new Mesh(compileGeometry, material), new OrthographicCamera(-1, 1, 1, -1, 0, 1));
    } finally {
      renderer.setRenderTarget(previousTarget);
    }
    progress("compiling");
    context.flush();
    const parallelCompile = context.getExtension("KHR_parallel_shader_compile");
    for (const program of renderer.info.programs ?? []) {
      const handle = program.program as WebGLProgram;
      if (!handle) throw new Error("Bake shader program allocation failed");
      while (parallelCompile && !context.getProgramParameter(handle, parallelCompile.COMPLETION_STATUS_KHR)) {
        if (context.isContextLost()) throw new Error("Bake context was lost during shader compilation");
        await checkpoint(true);
      }
      if (!context.getProgramParameter(handle, context.LINK_STATUS)) {
        throw new Error(`Bake shader link failed: ${context.getProgramInfoLog(handle)}`);
      }
    }
    await checkpoint(true);
    progress("sampling");
    while (tracer.samples < input.samples || native._pathTracer.isCompiling) {
      check();
      if (shaderFailure) throw shaderFailure;
      if (context.isContextLost()) throw new Error("Bake WebGL context was lost");
      tracer.renderSample();
      await waitForBakeGpu(context, () => checkpoint(true));
      progress("sampling", tracer.samples);
      // Each update is at most one 32x32 tile; never monopolize the authoring loop.
      await checkpoint(true);
    }
    if (shaderFailure) throw shaderFailure;
    const irradiance = new Float32Array(input.size ** 2 * 4);
    progress("readback", tracer.samples);
    await readBakePixels(renderer, tracer.target, irradiance, () => checkpoint(true));
    check();
    if (context.getError() !== context.NO_ERROR || irradiance.some((v) => !Number.isFinite(v))) {
      throw new Error("Bake readback failed or produced non-finite irradiance");
    }
    for (let i = 0; i < irradiance.length; i += 4) {
      if (atlas.positions[i + 3] && irradiance[i + 3] < 0.99) {
        throw new Error("A UV2 receiver could not be resolved in the transport scene");
      }
    }
    result = { irradiance, size: input.size, samples: input.samples, coveredTexels: atlas.coveredTexels,
      estimatedWorkingBytes: atlas.estimatedWorkingBytes, elapsedMs: performance.now() - started };
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    options.onProgress?.({ phase: "disposing", samples: result?.samples ?? 0, totalSamples: input.samples });
  } catch (error) { cleanupErrors.push(error); }
  const released = new Set<OwnedDisposable>();
  const release = (resource: OwnedDisposable) => {
    if (released.has(resource)) return;
    released.add(resource);
    try { resource.dispose(); } catch (error) { cleanupErrors.push(error); }
  };
  const disposal: BakePrototypeDisposal = {
    contextReleased: context === null,
    texturesBeforeDisposal: renderer?.info.memory.textures ?? 0,
    geometriesBeforeDisposal: renderer?.info.memory.geometries ?? 0,
  };
  if (tracer) {
    try {
      const native = internals(tracer);
      disposeMaterialResources(native._pathTracer.material, release);
      disposeMaterialResources(native._lowResPathTracer.material, release);
      release(native._lowResPathTracer);
      release(native._generator.geometry);
    } catch (error) { cleanupErrors.push(error); }
    release(tracer);
  }
  for (const resource of owned.reverse()) release(resource);
  if (renderer) release(renderer);
  if (context) {
    try {
      // Upstream owns inaccessible array targets/constructor temporaries. The job's
      // private context is the final ownership boundary, including partial failure.
      context.getExtension("WEBGL_lose_context")?.loseContext();
      disposal.contextReleased = context.isContextLost();
    } catch (error) { cleanupErrors.push(error); }
  }
  active = false;
  try { options.onDisposed?.(disposal); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, "Bake cleanup failed", { cause: failure });
  if (failed) throw failure;
  return result!;
}

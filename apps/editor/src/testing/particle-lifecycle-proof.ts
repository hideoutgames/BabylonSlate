import { Camera, Color4, Engine, FreeCamera, GPUParticleSystem, MeshBuilder, NullEngine, Scene, Vector3, type DataBuffer, type IParticleSystem, type NodeMaterial } from "@babylonjs/core";
import { particleLibraryFromAssets, type ParticleBurst, type ParticleColorTuple, type ParticleScalarValue, type ParticleVec3Tuple } from "@babylonslate/assets";
import type { ParticleBlendMode, ParticleLoopMode } from "@babylonslate/core";
import { createDefaultMaterialDocument, type MaterialDocument } from "@babylonslate/shader-graph";
import { createAppWebGpuEngine, createParticleMaterialResolver, ParticleService, type ParticleLibrary, type ParticleMaterialOwner, type ResourceLease } from "@babylonslate/render";

/** One Basic emitter per fixture System: point-emitted static quads unless a case moves them. */
type EmitterFixture = {
  material: string;
  rate?: number;
  lifetime?: number | ParticleScalarValue;
  loop?: ParticleLoopMode;
  speed?: number;
  direction?: ParticleVec3Tuple;
  size?: number;
  color?: ParticleColorTuple;
  blendMode?: ParticleBlendMode;
  bursts?: ParticleBurst[];
};

/** Each System's single slot is the emitter with the same guid; payloads go through the shipped normalizers. */
function fixtureLibrary(fixtures: Record<string, EmitterFixture>): ParticleLibrary {
  return particleLibraryFromAssets(Object.entries(fixtures).flatMap(([guid, fixture]) => [
    { guid, type: "ParticleSystem", payload: { emitterGuids: [guid] } },
    { guid, type: "ParticleEmitter", payload: {
      emitter: { loop: fixture.loop ?? "infinite", duration: 0.5, capacity: 64 },
      spawn: { rate: { mode: "constant", value: fixture.rate ?? 20 }, bursts: { enabled: !!fixture.bursts?.length, entries: fixture.bursts ?? [] } },
      shape: { kind: "point", direction1: fixture.direction ?? [0, 1, 0], direction2: fixture.direction ?? [0, 1, 0] },
      initialize: {
        lifetime: typeof fixture.lifetime === "object" ? fixture.lifetime : { mode: "constant", value: fixture.lifetime ?? 0.3 },
        speed: { mode: "constant", value: fixture.speed ?? 0 },
        size: { mode: "constant", value: fixture.size ?? 0.8 },
        color: { mode: "constant", color: fixture.color ?? [1, 1, 1, 1] },
      },
      render: { materialGuid: fixture.material, blendMode: fixture.blendMode ?? "additive" },
    } },
  ]));
}

/** Particle Color × a constant tint, so slot colours also prove `particle_color` reaches each slot's Material. */
function tintedParticleMaterial(name: string, tint: ParticleColorTuple): MaterialDocument {
  const document = createDefaultMaterialDocument(name, "particle");
  document.nodes.push(
    { id: "tint", type: "const.vec4", position: { x: 0, y: 120 }, properties: { value: [...tint] } },
    { id: "multiply", type: "math.multiply", position: { x: 150, y: 0 }, properties: {} },
  );
  document.edges = [
    { id: "color-multiply", sourceNodeId: "particleColor", sourcePinId: "color", targetNodeId: "multiply", targetPinId: "a" },
    { id: "tint-multiply", sourceNodeId: "tint", sourcePinId: "out", targetNodeId: "multiply", targetPinId: "b" },
    { id: "multiply-output", sourceNodeId: "multiply", sourcePinId: "out", targetNodeId: "output", targetPinId: "color" },
  ];
  return document;
}

/** Native draws, controlled simulation time, and readback; never substitutes processed GPU slots for visible particles. */
export async function runParticleLifecycleProof(backend: "webgl2" | "webgpu", gpu: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  // LastCreatedEngine deliberately lacks GPU particle support. The owning engine still must win.
  const otherEngine = new NullEngine();
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 1);
  // Native animate is invoked by the real Scene; one tick is updateSpeed simulation units.
  scene.getAnimationRatio = () => 1;
  const camera = new FreeCamera("Particle proof camera", new Vector3(0, 0, -4), scene);
  camera.setTarget(Vector3.Zero()); camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = camera.orthoBottom = -2; camera.orthoRight = camera.orthoTop = 2;
  scene.activeCamera = camera;
  // Red and blue slots differ only by Material; the default graph draws the emitter's own colour.
  const documents = new Map<string, MaterialDocument>([
    ["red", tintedParticleMaterial("Red particle", [1, 0, 0, 1])],
    ["blue", tintedParticleMaterial("Blue particle", [0, 0, 1, 1])],
    ["particle-color", createDefaultMaterialDocument("Particle Color", "particle")],
  ]);
  const materials = createParticleMaterialResolver({ scene, documents });
  let acquisitions = 0;
  let releases = 0;
  let resets = 0;
  let disposalResets = 0;
  const diagnostics: unknown[] = [];
  // Material leases are the only resource the service acquires per slot; count them.
  const counted = (acquire: (guid: string, owner: ParticleMaterialOwner) => ResourceLease<NodeMaterial> | null) =>
    (guid: string, owner: ParticleMaterialOwner): ResourceLease<NodeMaterial> | null => {
      const lease = acquire(guid, owner);
      if (!lease) return null;
      acquisitions += 1;
      let released = false;
      return { resource: lease.resource, key: lease.key, ready: lease.ready, release: () => {
        if (released) return;
        released = true; releases += 1; lease.release();
      } };
    };
  const service = new ParticleService({ scene, gpuSupported: gpu,
    acquireMaterial: counted(materials.acquire), onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const parents = ["red", "blue"].map((guid, index) => {
    const parent = MeshBuilder.CreateBox(guid, { size: 0.01 }, scene);
    parent.visibility = 0; parent.position.x = index === 0 ? -0.7 : 0.7;
    service.bindSlot(index + 1, parent);
    return parent;
  });
  const particleBuffers = new Set<DataBuffer>();
  const frameCpuMs: number[] = [];
  const bgra = backend === "webgpu" && (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm";
  const readFrame = async () => {
    const raw = await engine.readPixels(0, 0, 64, 64);
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  };
  const texel = (frame: Uint8Array, x: number, y: number) => {
    const i = (y * 64 + x) * 4;
    return { red: frame[i + (bgra ? 2 : 0)]!, green: frame[i + 1]!, blue: frame[i + (bgra ? 0 : 2)]! };
  };
  const sums = (frame: Uint8Array) => {
    let red = 0; let blue = 0;
    for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) { const value = texel(frame, x, y); red += value.red; blue += value.blue; }
    return { red, blue };
  };
  /** Mean grey level (0–255) of a size × size block. */
  const luminance = (frame: Uint8Array, x0: number, y0: number, size = 6) => {
    let total = 0;
    for (let y = y0; y < y0 + size; y += 1) for (let x = x0; x < x0 + size; x += 1) { const value = texel(frame, x, y); total += (value.red + value.green + value.blue) / 3; }
    return total / (size * size);
  };
  /** Runs of columns holding a lit red texel: separate particle bands along X. */
  const redColumnRuns = (frame: Uint8Array) => {
    let runs = 0; let previous = false;
    for (let x = 0; x < 64; x += 1) {
      let lit = false;
      for (let y = 0; y < 64 && !lit; y += 1) lit = texel(frame, x, y).red > 64;
      if (lit && !previous) runs += 1;
      previous = lit;
    }
    return runs;
  };
  let lastFrame: Uint8Array = new Uint8Array(64 * 64 * 4);
  const step = async (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      const started = performance.now();
      engine.beginFrame(); scene.render(); engine.endFrame();
      frameCpuMs.push(performance.now() - started);
      for (const system of scene.particleSystems) {
        for (const vertex of Object.values(system.vertexBuffers ?? {})) {
          const buffer = vertex.getBuffer();
          if (buffer) particleBuffers.add(buffer);
        }
        if (system.indexBuffer) particleBuffers.add(system.indexBuffer);
      }
      // WebGPU presentation invalidates the canvas texture at the next frame.
      if (i === count - 1) lastFrame = await readFrame();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  };
  const libraryFor = (rate: number, lifetime: number | ParticleScalarValue, loop: ParticleLoopMode) =>
    fixtureLibrary({ red: { material: "red", rate, lifetime, loop }, blue: { material: "blue", rate, lifetime, loop } });
  const configure = (rate: number, lifetime: number | ParticleScalarValue, loop: ParticleLoopMode) => service.setLibrary(libraryFor(rate, lifetime, loop));
  const simulationSpeeds = new WeakMap<IParticleSystem, number>();
  const assign = (guid: string, speed = 0.05, slotId = guid === "red" ? 1 : 2) => {
    service.handleCommand({ type: "assignParticle", actorGuid: guid, componentId: "particle", slotId, particleSystemGuid: guid });
    const native = scene.particleSystems[scene.particleSystems.length - 1]!;
    // Shader preparation must not consume the finite emitter's simulation clock.
    simulationSpeeds.set(native, speed);
    native.updateSpeed = 0;
    const reset = native.reset.bind(native);
    const dispose = native.dispose.bind(native);
    let retiring = false;
    native.dispose = (...args) => { retiring = true; return dispose(...args); };
    native.reset = () => {
      if (retiring) disposalResets += 1;
      else resets += 1;
      reset();
    };
    if ((native instanceof GPUParticleSystem) !== gpu) throw new Error(`Requested ${gpu ? "GPU" : "CPU"} particles were not constructed`);
    if (native instanceof GPUParticleSystem && !native.emitRateControl) throw new Error("GPU emitter lacks emit-rate control");
    return native;
  };
  const play = (guid: string, playing: boolean) => service.handleCommand({ type: "setParticlePlaying", actorGuid: guid, playing });
  const ready = async (systems: IParticleSystem[]) => {
    const pending = [...systems];
    if (!pending.length) throw new Error("No particle systems were prepared");
    for (let i = 0; i < 120; i += 1) {
      if (pending.every((system) => system.isStarted() && system.isReady())) {
        for (const system of pending) system.updateSpeed = simulationSpeeds.get(system) ?? 0.05;
        return;
      }
      await step();
    }
    throw new Error(`Particle preparation did not finish: ${JSON.stringify(diagnostics)}`);
  };
  const captures: Array<{ name: string; red: number; blue: number; systems: number; processed: number[]; configuredSimulationStep: number[] }> = [];
  const gpuSamples: unknown[] = [];
  const capture = async (name: string) => captures.push({ name, ...sums(lastFrame), systems: scene.particleSystems.length,
    processed: scene.particleSystems.map((system) => system.getActiveCount()),
    configuredSimulationStep: scene.particleSystems.map((system) => system.updateSpeed) });
  try {
    engine.setSize(64, 64);
    configure(20, 0.3, "infinite");
    const natives = [assign("red"), assign("blue")];
    for (const system of natives) system.minLifeTime = system.maxLifeTime = 0.8;
    await ready(natives); await step(8); await capture("two-materials");
    // Readback belongs only in this controlled correctness fixture. Capture
    // native positions separately from processed counts and visible pixels.
    if (backend === "webgpu" && gpu) for (const system of natives) {
      const native = system as unknown as { _attributesStrideSize: number; _platform: {
        _bufferComputeShader: Array<{ read(offset?: number, size?: number, buffer?: ArrayBufferView, noDelay?: boolean): Promise<ArrayBufferView> }>;
      } };
      const buffers = [];
      for (const buffer of native._platform._bufferComputeShader) {
        const data = await buffer.read(undefined, undefined, undefined, true);
        const floats = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
        buffers.push(Array.from({ length: Math.min(system.getActiveCount(), 8) }, (_, index) =>
          Array.from(floats.subarray(index * native._attributesStrideSize, index * native._attributesStrideSize + 8))));
      }
      gpuSamples.push({ name: system.name, buffers, emitter: (system.emitter as { getWorldMatrix(): { asArray(): ArrayLike<number> } }).getWorldMatrix().asArray() });
    }
    const stable = { acquisitions, releases, materials: scene.materials.length, systems: scene.particleSystems.length };
    for (let i = 0; i < 1000; i += 1) { play("red", true); play("blue", true); }
    if (acquisitions !== stable.acquisitions || releases !== stable.releases || scene.materials.length !== stable.materials || resets !== 0)
      throw new Error("Repeated Play changed stable resource ownership");
    // Existing particles keep their older lifetime after an authoring edit.
    for (const system of natives) system.minLifeTime = system.maxLifeTime = 0.3;
    play("red", false); play("blue", false);
    service.setPaused(true); await step(12); await capture("paused-drain");
    if (scene.particleSystems.length !== 2) throw new Error("Paused simulation advanced drain time");
    service.setPaused(false); await step(2); await capture("draining");
    await step(18); await capture("retired");
    if (scene.particleSystems.length || acquisitions !== releases) throw new Error(`Stopped particles retained native systems or leases: ${JSON.stringify({ captures, stats: service.stats(), acquisitions, releases, native: scene.particleSystems.map((system) => ({ ready: system.isReady(), started: system.isStarted(), speed: system.updateSpeed, processed: system.getActiveCount() })) })}`);
    play("blue", true); await ready(scene.particleSystems); await step(5); await capture("restart-blue");
    service.resetSession();
    // Reverse order in a new run still binds each slot to its own Material instance.
    service.bindSlot(1, parents[0]!); service.bindSlot(2, parents[1]!);
    const reverse = [assign("blue"), assign("red")];
    await ready(reverse); await step(5); await capture("reverse-order");
    service.handleCommand({ type: "despawn", slotId: 1, actorGuid: "red" });
    await step(2); await capture("surviving-blue");
    service.resetSession();
    configure(0.5, 2, "infinite");
    const lowFresh = assign("red", 0.25);
    await ready([lowFresh]);
    await step(7); await capture("fractional-pending");
    await step(2); await capture("fractional-emission");
    play("red", false); await step(10); await capture("fractional-retired");
    // Once emitter with a falling Lifetime curve over its cycle: the first particles
    // outlive the lifetime current at stop, so the drain must wait for the curve maximum.
    configure(20, { mode: "curve", keys: [{ t: 0, value: 0.75 }, { t: 1, value: 0.3 }] }, "once");
    const finite = assign("red");
    await ready([finite]); await step(4); await capture("finite-visible");
    await step(9); await capture("finite-gradient-drain");
    await step(21); await capture("finite-retired");
    if (scene.particleSystems.length) throw new Error("Finite emitter did not complete drain");
    // Blend modes over a mid-grey clear; static quads at the origin (slot 3 is unbound).
    // Standard uses black at half alpha, which only an alpha blend darkens. A transparent
    // texel under Multiply goes white through ParticleBlendMultiplyBlock and leaves the background.
    const blendCases: Array<{ name: string; blendMode: ParticleBlendMode; centre: number; background: number }> = [];
    const blendFixtures: Array<[string, ParticleBlendMode, ParticleColorTuple]> = [
      ["additive", "additive", [0.15, 0.15, 0.15, 1]],
      ["standard", "standard", [0, 0, 0, 0.5]],
      ["add", "add", [0.3, 0.3, 0.3, 1]],
      ["multiply", "multiply", [0.5, 0.5, 0.5, 1]],
      ["subtract", "subtract", [0.3, 0.3, 0.3, 1]],
      ["multiply-transparent", "multiply", [0, 0, 0, 0]],
    ];
    scene.clearColor = new Color4(0.5, 0.5, 0.5, 1);
    for (const [name, blendMode, color] of blendFixtures) {
      service.setLibrary(fixtureLibrary({ blend: { material: "particle-color", size: 1, color, blendMode } }));
      const native = assign("blend", 0.05, 3);
      await ready([native]); await step(6);
      blendCases.push({ name, blendMode, centre: luminance(lastFrame, 29, 29), background: luminance(lastFrame, 2, 2) });
      service.resetSession();
    }
    scene.clearColor = new Color4(0, 0, 0, 1);
    // Bursts only, moving +X from x = -1.6: one burst of 5 at 0.3 s in every 0.5 s cycle.
    // Before it fires, the claimed GPU ring must draw nothing. At 1.55 s the bursts from
    // 0.3, 0.8 and 1.3 s are separate bands; a recycling ring would keep only the newest.
    const burstParent = MeshBuilder.CreateBox("bursts", { size: 0.01 }, scene);
    burstParent.visibility = 0; burstParent.position.x = -1.6;
    service.setLibrary(fixtureLibrary({ bursts: { material: "red", rate: 0, lifetime: 1.5, speed: 1, direction: [1, 0, 0], size: 0.2,
      bursts: [{ time: 0.3, count: 5, cycles: 1, interval: 0.5 }] } }));
    service.bindSlot(4, burstParent);
    const burstNative = assign("bursts", 0.05, 4);
    await ready([burstNative]); await step(2);
    const beforeFirstBurst = sums(lastFrame);
    await step(29);
    const bursts = { beforeFirstBurst, bands: redColumnRuns(lastFrame), afterBursts: sums(lastFrame) };
    service.resetSession();
    burstParent.dispose();
    const sceneIsolation: Array<{ reverse: boolean; world: { red: number; blue: number }; layer: { red: number; blue: number }; survivor: { red: number; blue: number } }> = [];
    const layer = new Scene(engine);
    layer.clearColor = new Color4(0, 0, 0, 1);
    layer.getAnimationRatio = () => 1;
    const layerCamera = new FreeCamera("Particle SceneLayer camera", camera.position.clone(), layer);
    layerCamera.setTarget(Vector3.Zero()); layerCamera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    layerCamera.orthoLeft = layerCamera.orthoBottom = -2; layerCamera.orthoRight = layerCamera.orthoTop = 2;
    layer.activeCamera = layerCamera;
    const layerMaterials = createParticleMaterialResolver({ scene: layer, documents });
    const layered = new ParticleService({ scene, gpuSupported: gpu,
      sceneForSlot: (slot) => slot === 2 ? layer : scene,
      acquireMaterial: counted((guid, owner) => (owner.scene === layer ? layerMaterials : materials).acquire(guid, owner)),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    layered.setLibrary(libraryFor(20, 0.3, "infinite"));
    const layerFrame = async () => {
      engine.beginFrame(); scene.render(); layer.render(); engine.endFrame();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const captureScene = async (owner: Scene) => {
      engine.beginFrame(); owner.render(); engine.endFrame();
      return sums(await readFrame());
    };
    try {
      for (const reverseOrder of [false, true]) {
        for (const guid of reverseOrder ? ["blue", "red"] : ["red", "blue"]) layered.handleCommand({ type: "assignParticle",
          slotId: guid === "red" ? 1 : 2, actorGuid: guid, componentId: "particle", particleSystemGuid: guid });
        const natives = [...scene.particleSystems, ...layer.particleSystems];
        for (const native of natives) native.updateSpeed = 0;
        let prepared = false;
        for (let frame = 0; frame < 120; frame += 1) {
          if (natives.length === 2 && natives.every((native) => native.isStarted() && native.isReady())) { prepared = true; break; }
          await layerFrame();
        }
        if (!prepared) throw new Error("World/SceneLayer particle materials did not prepare");
        for (const native of natives) native.updateSpeed = 0.05;
        for (let frame = 0; frame < 8; frame += 1) await layerFrame();
        const world = await captureScene(scene);
        const overlay = await captureScene(layer);
        layered.handleCommand({ type: "despawn", slotId: 1, actorGuid: "red" });
        const survivor = await captureScene(layer);
        sceneIsolation.push({ reverse: reverseOrder, world, layer: overlay, survivor });
        layered.resetSession();
      }
    } finally { layered.dispose(); layerMaterials.dispose(); layer.dispose(); }
    const baseline = { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length, geometry: scene.geometries.length,
      gpuTextures: engine.getLoadedTexturesCache().length };
    configure(20, 0.3, "infinite");
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const system = assign("red");
      await ready([system]); await step(2); service.resetSession();
    }
    await step(2);
    const final = { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length, geometry: scene.geometries.length,
      gpuTextures: engine.getLoadedTexturesCache().length };
    frameCpuMs.sort((a, b) => a - b);
    const percentile = (fraction: number) => frameCpuMs[Math.min(frameCpuMs.length - 1, Math.floor(frameCpuMs.length * fraction))] ?? 0;
    return { requestedBackend: backend, effectiveBackend: engine.isWebGPU ? "webgpu" : `webgl${(engine as Engine).webGLVersion}`,
      simulation: gpu ? "gpu" : "cpu", driver: "getGlInfo" in engine ? engine.getGlInfo() : engine.getInfo(), userAgent: navigator.userAgent,
      resolution: { width: 64, height: 64 },
      captures, gpuSamples, sceneIsolation, blendCases, bursts, diagnostics, resets, disposalResets, acquisitions, releases, baseline, final,
      nativeSimulationAndSubmissionCpuMs: { samples: frameCpuMs.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
      particleBuffersAcquired: particleBuffers.size, liveParticleBuffers: [...particleBuffers].filter((buffer) => buffer.references > 0).length };
  } finally { service.dispose(); materials.dispose(); scene.dispose(); otherEngine.dispose(); engine.dispose(); canvas.remove(); }
}

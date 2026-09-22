import { Camera, Color4, Engine, FreeCamera, GPUParticleSystem, MeshBuilder, NullEngine, RawTexture, Scene, Vector3, type DataBuffer, type IParticleSystem } from "@babylonjs/core";
import { createDefaultParticleEmitterPayload, createDefaultParticleSystemPayload } from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createAppWebGpuEngine, createParticleMaterialResolver, ParticleService, type ParticleLibrary } from "@babylonslate/render";

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
  const textures = new Map(["red", "blue"].map((guid) => {
    const rgba = guid === "red" ? [255, 0, 0, 255] : [0, 0, 255, 255];
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(rgba), 1, 1, scene, false, false);
    texture.hasAlpha = true;
    return [guid, texture] as const;
  }));
  const materials = createParticleMaterialResolver({ scene, documents: new Map([["graph", createDefaultMaterialDocument("Shared particle graph", "particle")]]) });
  let acquisitions = 0;
  let releases = 0;
  let resets = 0;
  const diagnostics: unknown[] = [];
  const acquireTexture = (guid: string) => {
      const resource = textures.get(guid);
      if (!resource) return null;
      acquisitions += 1;
      let released = false;
      return { key: guid, resource, release: () => { if (!released) { released = true; releases += 1; } } };
  };
  const service = new ParticleService({ scene, gpuSupported: gpu,
    acquireTexture, acquireMaterial: materials.acquire, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const parents = ["red", "blue"].map((guid, index) => {
    const parent = MeshBuilder.CreateBox(guid, { size: 0.01 }, scene);
    parent.visibility = 0; parent.position.x = index === 0 ? -0.7 : 0.7;
    service.bindSlot(index + 1, parent);
    return parent;
  });
  const particleBuffers = new Set<DataBuffer>();
  const frameCpuMs: number[] = [];
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
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  };
  const pixels = async () => {
    const raw = await engine.readPixels(0, 0, 64, 64);
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const bgra = backend === "webgpu" && (navigator as Navigator & { gpu: { getPreferredCanvasFormat(): string } }).gpu.getPreferredCanvasFormat() === "bgra8unorm";
    let red = 0; let blue = 0;
    for (let i = 0; i < bytes.length; i += 4) { red += bytes[i + (bgra ? 2 : 0)]!; blue += bytes[i + (bgra ? 0 : 2)]!; }
    return { red, blue };
  };
  const libraryFor = (rate: number, lifetime: number, looping: boolean, material: boolean): ParticleLibrary => ({
    emitters: new Map(["red", "blue"].map((guid) => [guid, {
      ...createDefaultParticleEmitterPayload(), textureGuid: guid, materialGuid: material ? "graph" : null,
      capacity: 64, emitRate: rate, minLifeTime: lifetime, maxLifeTime: lifetime, minEmitPower: 0, maxEmitPower: 0,
      minSize: 0.8, maxSize: 0.8, sizeGradient: [{ t: 0, value: 1 }, { t: 1, value: 1 }],
      colorGradient: [{ t: 0, color: [1, 1, 1, 1] as [number, number, number, number] }, { t: 1, color: [1, 1, 1, 1] as [number, number, number, number] }],
    }])), systems: new Map(["red", "blue"].map((guid) => [guid, { ...createDefaultParticleSystemPayload(), emitterGuids: [guid], looping, duration: 0.5 }])) });
  const configure = (rate: number, lifetime: number, looping: boolean, material: boolean) => service.setLibrary(libraryFor(rate, lifetime, looping, material));
  const simulationSpeeds = new WeakMap<IParticleSystem, number>();
  const assign = (guid: string, speed = 0.05) => {
    service.handleCommand({ type: "assignParticle", actorGuid: guid, componentId: "particle", slotId: guid === "red" ? 1 : 2, particleSystemGuid: guid });
    const native = scene.particleSystems[scene.particleSystems.length - 1]!;
    // Shader preparation must not consume the finite emitter's simulation clock.
    simulationSpeeds.set(native, speed);
    native.updateSpeed = 0;
    const reset = native.reset.bind(native);
    native.reset = () => { resets += 1; reset(); };
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
  const capture = async (name: string) => captures.push({ name, ...await pixels(), systems: scene.particleSystems.length,
    processed: scene.particleSystems.map((system) => system.getActiveCount()),
    configuredSimulationStep: scene.particleSystems.map((system) => system.updateSpeed) });
  try {
    engine.setSize(64, 64);
    configure(20, 0.3, true, true);
    const natives = [assign("red"), assign("blue")];
    for (const system of natives) system.minLifeTime = system.maxLifeTime = 0.8;
    await ready(natives); await step(8); await capture("two-textures");
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
    if (scene.particleSystems.length || acquisitions !== releases) throw new Error("Stopped particles retained native systems or leases");
    play("blue", true); await ready(scene.particleSystems); await step(5); await capture("restart-blue");
    service.resetSession();
    // Reverse order in a new run still isolates the graph's mutable texture blocks.
    service.bindSlot(1, parents[0]!); service.bindSlot(2, parents[1]!);
    const reverse = [assign("blue"), assign("red")];
    await ready(reverse); await step(5); await capture("reverse-order");
    service.handleCommand({ type: "despawn", slotId: 1, actorGuid: "red" });
    await step(2); await capture("surviving-blue");
    service.resetSession();
    configure(0.5, 2, true, false);
    const lowFresh = assign("red", 0.25);
    await ready([lowFresh]);
    await step(7); await capture("fractional-pending");
    await step(2); await capture("fractional-emission");
    play("red", false); await step(10); await capture("fractional-retired");
    configure(20, 0.3, false, false);
    const finite = assign("red");
    finite.addLifeTimeGradient(0, 0.75);
    finite.addLifeTimeGradient(1, 0.75);
    await ready([finite]); await step(4); await capture("finite-visible");
    await step(9); await capture("finite-gradient-drain");
    await step(21); await capture("finite-retired");
    if (scene.particleSystems.length) throw new Error("Finite emitter did not complete drain");
    const sceneIsolation: Array<{ reverse: boolean; world: { red: number; blue: number }; layer: { red: number; blue: number }; survivor: { red: number; blue: number } }> = [];
    const layer = new Scene(engine);
    layer.clearColor = new Color4(0, 0, 0, 1);
    layer.getAnimationRatio = () => 1;
    const layerCamera = new FreeCamera("Particle SceneLayer camera", camera.position.clone(), layer);
    layerCamera.setTarget(Vector3.Zero()); layerCamera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    layerCamera.orthoLeft = layerCamera.orthoBottom = -2; layerCamera.orthoRight = layerCamera.orthoTop = 2;
    layer.activeCamera = layerCamera;
    const layerMaterials = createParticleMaterialResolver({ scene: layer, documents: new Map([["graph", createDefaultMaterialDocument("Shared particle graph", "particle")]]) });
    const layered = new ParticleService({ scene, gpuSupported: gpu, acquireTexture,
      sceneForSlot: (slot) => slot === 2 ? layer : scene,
      acquireMaterial: (guid, owner) => (owner.scene === layer ? layerMaterials : materials).acquire(guid, owner),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    layered.setLibrary(libraryFor(20, 0.3, true, true));
    const layerFrame = async () => {
      engine.beginFrame(); scene.render(); layer.render(); engine.endFrame();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    };
    const captureScene = async (owner: Scene) => {
      engine.beginFrame(); owner.render(); engine.endFrame();
      return pixels();
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
    configure(20, 0.3, true, false);
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const system = assign("red");
      await ready([system]); await step(2); service.resetSession();
    }
    await step(2);
    const final = { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length, geometry: scene.geometries.length,
      gpuTextures: engine.getLoadedTexturesCache().length };
    frameCpuMs.sort((a, b) => a - b);
    const percentile = (fraction: number) => frameCpuMs[Math.min(frameCpuMs.length - 1, Math.floor(frameCpuMs.length * fraction))] ?? 0;
    return { backend, effectiveBackend: engine.isWebGPU ? "webgpu" : `webgl${(engine as Engine).webGLVersion}`, gpu, adapter: engine.getInfo(),
      captures, sceneIsolation, diagnostics, resets, acquisitions, releases, baseline, final,
      nativeSimulationAndSubmissionCpuMs: { samples: frameCpuMs.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
      particleBuffersAcquired: particleBuffers.size, liveParticleBuffers: [...particleBuffers].filter((buffer) => buffer.references > 0).length };
  } finally { service.dispose(); materials.dispose(); scene.dispose(); otherEngine.dispose(); engine.dispose(); canvas.remove(); }
}

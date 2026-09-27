import { Camera, DirectionalLight, Engine, Vector3 } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody, sampleWaterSurface } from "@babylonslate/core";
import { createAppWebGpuEngine, createParticlePreviewScene, createWaterMesh, setSceneWaterTime, updateSceneWater } from "@babylonslate/render";
import { createLandscapeMesh } from "../../../../packages/render/src/landscape-mesh";

/** Test-build-only captures of production water, including a fixed-world transform comparison. */
export async function runWaterRenderingProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 400;
  document.getElementById("root")!.append(canvas);
  // Match the app: large-world rendering makes shader positions eye-relative.
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  const host = createParticlePreviewScene(engine, { skybox: true });
  const { scene, camera } = host;
  const sun = new DirectionalLight("sun", new Vector3(-0.3, -1, 0.6), scene);
  sun.intensity = 1.4;
  camera.alpha = -Math.PI / 2; camera.beta = 1.03; camera.radius = 24;
  camera.maxZ = 1200;
  for (const mesh of scene.meshes) if (mesh.metadata?.skybox) mesh.infiniteDistance = true;
  const capture = async () => {
    await scene.whenReadyAsync();
    camera.getViewMatrix(true);
    updateSceneWater(scene);
    await scene.whenReadyAsync();
    engine.beginFrame();
    try {
      scene.render();
      const raw = await engine.readPixels(0, 0, canvas.width, canvas.height);
      if (!raw) throw new Error("Missing water pixels");
      const pixels = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      // Capture the rendered canvas directly; readback is separately used for the invariant check.
      return { pixels: Array.from(pixels), png: canvas.toDataURL("image/png") };
    } finally { engine.endFrame(); }
  };
  try {
    const evidence: Record<string, string> = {};
    const differences: Record<string, number> = {};
    const brightness: Record<string, number> = {};
    const pan: Record<string, number> = {};
    for (const style of ["realistic", "stylized"] as const) {
      setSceneWaterTime(scene, 1.7);
      const water = createDefaultWaterDefinition(style);
      const stable = createWaterMesh(scene, "transform-check", normalizeWaterBody({ width: 80, length: 80, waveScale: 0 }, "ocean"), { ...water, foamAmount: 0, depthColorDistance: 0.1 });
      const before = await capture();
      stable.position.set(7, 0, -4); stable.scaling.set(2, 4, 1.5);
      updateSceneWater(scene);
      const after = await capture();
      let sum = 0, count = 0;
      for (let y = 120; y < 280; y++) for (let x = 200; x < 440; x++) for (let c = 0; c < 3; c++) {
        const i = (y * canvas.width + x) * 4 + c;
        sum += Math.abs(before.pixels[i]! - after.pixels[i]!); count++;
      }
      differences[style] = sum / count;
      stable.dispose();
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 28, length: 24, waveScale: 1 }), water);
      const lit = await capture();
      evidence[style + "-lake"] = lit.png;
      // Mean centre brightness: an oversized fragment shader can compile but render black under several lights.
      let light = 0, samples = 0;
      for (let y = 150; y < 250; y++) for (let x = 220; x < 420; x++) {
        const i = (y * canvas.width + x) * 4;
        light += (lit.pixels[i]! + lit.pixels[i + 1]! + lit.pixels[i + 2]!) / 3; samples++;
      }
      brightness[style] = light / samples;
      lake.dispose();
      camera.beta = 1.38; camera.radius = 16;
      const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 120, length: 120 }, "ocean"), water);
      evidence[style + "-ocean"] = (await capture()).png;
      ocean.dispose();
      const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"), water);
      camera.setTarget(new Vector3(4000, 0, -2000), false, false, true);
      evidence[style + "-global"] = (await capture()).png;
      global.dispose();
      camera.setTarget(Vector3.Zero(), false, false, true); camera.beta = 1.03; camera.radius = 24;
      // Moving the eye must reveal a different part of the world-anchored pattern. If shading used
      // large-world rendering's eye-relative positions, a pure camera translation would change nothing.
      const still = createWaterMesh(scene, "pan-check", normalizeWaterBody({ width: 300, length: 300, waveScale: 0 }, "ocean"), { ...water, foamAmount: 0, sparkles: 0 });
      camera.beta = 0.6; camera.radius = 14;
      const centre = (pixels: number[]) => {
        const values: number[] = [];
        for (let y = 150; y < 250; y++) for (let x = 220; x < 420; x++) for (let c = 0; c < 3; c++) values.push(pixels[(y * canvas.width + x) * 4 + c]!);
        return values;
      };
      const a = centre((await capture()).pixels);
      camera.setTarget(new Vector3(7.3, 0, 4.1), false, false, true);
      const b = centre((await capture()).pixels);
      pan[style] = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
      still.dispose();
      camera.setTarget(Vector3.Zero(), false, false, true);
      camera.alpha = -Math.PI / 2; camera.beta = 1.03; camera.radius = 24;
    }
    // A hidden landscape still supplies the water field. The visible crest must
    // cross its elevated floor, while a trough reveals the unchanged background.
    for (const mesh of scene.meshes) mesh.isVisible = false;
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -4; camera.orthoRight = 4; camera.orthoTop = 2.5; camera.orthoBottom = -2.5;
    camera.beta = 0.01; camera.radius = 24;
    camera.setTarget(Vector3.Zero(), false, false, true);
    const terrain = createLandscapeMesh(scene, "wave-floor", { width: 20, depth: 20, subdivisions: 8, heights: Array(81).fill(0.6) });
    for (const mesh of terrain.getChildMeshes()) mesh.isVisible = false;
    const empty = await capture();
    const definition = { ...createDefaultWaterDefinition("stylized"), waveHeight: 4, waveLength: 100, choppiness: 0,
      foamAmount: 0, sparkles: 0, reflectionStrength: 0, opacity: 1 };
    const body = normalizeWaterBody({ width: 20, length: 20 }, "ocean");
    const samples = Array.from({ length: 80 }, (_, i) => ({ time: i * 0.25,
      height: sampleWaterSurface(definition, body, { x: 0, y: 0, z: 0 }, i * 0.25).height }));
    const crest = samples.reduce((a, b) => a.height > b.height ? a : b);
    const trough = samples.reduce((a, b) => a.height < b.height ? a : b);
    const water = createWaterMesh(scene, "wave-terrain", body, definition);
    const difference = (pixels: number[]) => {
      let sum = 0;
      for (let y = 195; y < 205; y++) for (let x = 315; x < 325; x++) for (let c = 0; c < 3; c++) {
        const i = (y * canvas.width + x) * 4 + c;
        sum += Math.abs(pixels[i]! - empty.pixels[i]!);
      }
      return sum / 300;
    };
    setSceneWaterTime(scene, crest.time);
    const high = await capture();
    setSceneWaterTime(scene, trough.time);
    const low = await capture();
    evidence["terrain-crest"] = high.png; evidence["terrain-trough"] = low.png;
    const waveTerrain = { crestHeight: crest.height, troughHeight: trough.height,
      crestDifference: difference(high.pixels), troughDifference: difference(low.pixels) };
    water.dispose(); terrain.dispose();
    return { evidence, differences, brightness, pan, waveTerrain };
  } finally {
    const device = (engine as { _device?: { queue: { onSubmittedWorkDone(): Promise<void> } } })._device;
    engine.flushFramebuffer(); await device?.queue.onSubmittedWorkDone();
    host.dispose(); await host.whenReleased(); engine.dispose(); canvas.remove();
  }
}

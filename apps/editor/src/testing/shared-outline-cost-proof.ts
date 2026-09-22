/** Fixed-output production measurements. Software adapters are functional evidence only. */
import { Color3, Color4, Engine, EngineInstrumentation, FreeCamera, HemisphericLight, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { SharedOutlineOwner, beginEngineDrawCallFrame, createAppWebGpuEngine, readEngineDrawCalls, requestRenderPath } from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { managedRenderReservations } from "@babylonslate/render/managed-render-resources";

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
  return { count: sorted.length, median: at(0.5), p95: at(0.95), maximum: sorted.at(-1) ?? null };
}

export async function runSharedOutlineCostProof(backend: "webgl2" | "webgpu") {
  const progress = document.createElement("pre");
  progress.dataset.testid = "shared-outline-cost-progress";
  document.getElementById("root")!.append(progress);
  let phase = "engine initialization";
  const publish = (status: string, detail: unknown = null) => {
    progress.textContent = JSON.stringify({ backend, phase, status, detail });
  };
  publish("running");
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 360;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { stencil: true });
  engine.setSize(640, 360);
  requestRenderPath(engine, { renderPath: "forward" });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.05, 0.05, 1);
  const camera = new FreeCamera("Cost Camera", new Vector3(0, 5, -20), scene);
  camera.setTarget(Vector3.Zero()); scene.activeCamera = camera;
  new HemisphericLight("Cost Light", new Vector3(0.2, 1, -0.5), scene);
  const material = new StandardMaterial("Cost Receiver", scene);
  material.diffuseColor = new Color3(0.6, 0.6, 0.6);
  const source = MeshBuilder.CreateBox("Cost Source", { size: 0.55 }, scene);
  source.material = material; source.position.x = 100;
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("cost");
  const renderer = new SceneRenderCoordinator(scene), detach = renderer.attachSharedOutline(view);
  let cpuMs = 0;
  // Babylon 9.20 whole-frame WebGPU timestamps use the removed encoder API.
  // A WebGPU timestamp-query capability is not a valid whole-frame measurement.
  const instrument = !engine.isWebGPU && engine.getCaps().timerQuery ? new EngineInstrumentation(engine) : null;
  if (instrument) instrument.captureGPUFrameTime = true;
  const gpuStatus = () => !instrument ? "unsupported" : instrument.gpuFrameTimeCounter.count ? "available" : "pending";
  const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  const draw = () => {
    const start = performance.now();
    engine.beginFrame(); beginEngineDrawCallFrame(engine);
    try {
      const result = renderer.render();
      if (!result.rendered || !result.readyForPresentation || result.path !== "frameGraph")
        throw new Error("Cost sample was not a ready production FrameGraph frame.");
    } finally { engine.endFrame(); }
    cpuMs = performance.now() - start;
  };
  const warm = async () => {
    await renderer.prepare();
    for (let frame = 0; frame < 15; frame++) { await nextFrame(); draw(); }
  };
  const measurements = [];
  const lifecycle = [];
  try {
    for (const count of [12, 192]) {
      const instances = Array.from({ length: count }, (_, index) => {
        const mesh = source.createInstance(`Cost Actor ${index}`);
        mesh.position.set((index % 16 - 7.5) * 0.75, Math.floor(index / 16) * 0.6 - 3, 0);
        return mesh;
      });
      const targets = instances.map((mesh, index) => ({ key: `cost-${count}-${index}`, meshes: [mesh] }));
      const setMode = (mode: string) => {
        const contributions = new Map<string, Parameters<typeof view.setContribution>[1]>();
        if (mode === "global" || mode === "all") contributions.set("global", {
          kind: "global", targets, color: [0.03, 0.03, 0.03], width: 1, throughMeshes: false,
        });
        if (mode === "component" || mode === "all") targets.forEach((target, index) => {
          contributions.set(`component-${index}`, { kind: "component", targets: [target],
            color: [(index % 5) / 4, (index % 7) / 6, (index % 11) / 10], width: 1, throughMeshes: index % 2 === 0 });
        });
        if (mode === "selection" || mode === "all") contributions.set("selection", {
          kind: "selection", targets: targets.slice(0, 3), color: [0.42, 0.78, 1], width: 1, throughMeshes: true,
        });
        view.replaceContributions(contributions, instances); renderer.invalidate();
      };
      for (const mode of ["off", "global", "component", "selection", "all", "off-restored"]) {
        phase = `${count} instances: ${mode}`;
        publish("preparing", { measurements, lifecycle });
        setMode(mode); await warm();
        const before = { owner: owner.diagnostics(), view: view.diagnostics() };
        const cpu: number[] = [], cadence: number[] = [], gpu: number[] = [], draws: number[] = [];
        let previous = await nextFrame();
        for (let frame = 0; frame < 60; frame++) {
          const now = await nextFrame(); cadence.push(now - previous); previous = now;
          draw(); cpu.push(cpuMs); draws.push(readEngineDrawCalls(engine));
          if (instrument?.gpuFrameTimeCounter.count) gpu.push(instrument.gpuFrameTimeCounter.current / 1_000_000);
        }
        const passes = renderer.sharedOutlineDiagnostics();
        measurements.push({ count, mode, width: engine.getRenderWidth(), height: engine.getRenderHeight(),
          scalingLevel: engine.getHardwareScalingLevel(), cpuMs: distribution(cpu), cadenceMs: distribution(cadence),
          gpuMs: distribution(gpu), gpuStatus: gpuStatus(), drawCalls: distribution(draws), passes,
          // All boxes have 12 triangles. Mask instance dispatch can submit nonmembers
          // and discard them in the fragment shader; this is an upper bound, not a GPU counter.
          submittedTriangleUpperBound: (count + 1) * 12 * (1 + Math.max(0, passes.drawingPassCount - 1)) + (passes.drawingPassCount ? 2 : 0),
          reservations: managedRenderReservations(engine), before,
          after: { owner: owner.diagnostics(), view: view.diagnostics() } });
      }
      for (let cycle = 0; cycle < 4; cycle++) {
        phase = `${count} instances: lifecycle ${cycle} all at 800x450`;
        publish("preparing", { measurements, lifecycle });
        setMode("all"); engine.setSize(800, 450); renderer.invalidate(); await warm();
        phase = `${count} instances: lifecycle ${cycle} selection`;
        publish("preparing", { measurements, lifecycle });
        setMode("selection"); await warm();
        phase = `${count} instances: lifecycle ${cycle} off at 640x360`;
        publish("preparing", { measurements, lifecycle });
        setMode("off"); engine.setSize(640, 360); renderer.invalidate(); await warm();
        await owner.whenReleased();
        lifecycle.push({ count, cycle, reservations: managedRenderReservations(engine), owner: owner.diagnostics(),
          passes: renderer.sharedOutlineDiagnostics() });
      }
      for (const mesh of instances) mesh.dispose();
      renderer.invalidate();
    }
    publish("complete", { measurements, lifecycle });
    return { requestedBackend: backend, effectiveBackend: engine.isWebGPU ? "webgpu" : engine instanceof Engine && engine.webGLVersion === 2 ? "webgl2" : "webgl1",
      adapter: engine.getInfo(), viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio,
      output: { width: 640, height: 360, dynamicResolution: false, samples: 1 },
      policy: { outlineWidthOutputPixels: 1, warmupFrames: 15, measuredFrames: 60,
        cpu: "Synchronous Engine beginFrame + coordinator render + endFrame",
        gpu: "Asynchronous whole-engine query samples when supported; WebGPU unavailable",
        cadence: "requestAnimationFrame intervals, not GPU timing or headroom",
        geometry: "Conservative submitted triangle upper bound, not a measured GPU counter",
        interaction: "Synthetic membership/resize only; hands-on gizmo and Play/scene transitions require separate acceptance" },
      measurements, lifecycle };
  } catch (error) {
    publish("failed", { error: String(error), measurements, lifecycle,
      adapter: engine.getInfo(), tasks: renderer.taskNames(), owner: owner.diagnostics(),
      view: view.diagnostics(), reservations: managedRenderReservations(engine) });
    throw new Error(`Shared outline cost failed at ${phase}: ${String(error)}`, { cause: error });
  } finally {
    detach(); await renderer.retire(); view.dispose(); await owner.whenReleased();
    instrument?.dispose(); scene.dispose(); engine.dispose(); canvas.remove();
  }
}

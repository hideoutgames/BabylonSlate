/** Explicit opt-in performance experiment. No device qualification or pass/fail threshold. */
import {
  Color3, Color4, Engine, EngineInstrumentation, FreeCamera, HemisphericLight,
  MeshBuilder, Scene, StandardMaterial, Vector3,
} from "@babylonjs/core";
import { Lattice } from "@babylonjs/core/Meshes/lattice";
import { LatticePluginMaterial } from "@babylonjs/core/Meshes/lattice.material";
import { createAppWebGpuEngine, disposeMeshLatticeDeformer, requestRenderPath, setMeshLatticeDeformer } from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";

export interface LatticeDeformerCostOptions {
  vertexCounts?: readonly (16384 | 65536)[];
  resolutions?: readonly (2 | 3 | 4)[];
  warmupMs?: number;
  sampleMs?: number;
  repetitions?: number;
  width?: number;
  height?: number;
}

const modes = ["baseline", "stock-unchanged", "stock-changing", "adapted-unchanged", "adapted-changing"] as const;
type Mode = typeof modes[number];

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
  return { count: sorted.length, median: at(0.5), p95: at(0.95), maximum: sorted.at(-1) ?? null };
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`Invalid lattice cost ${name}: expected ${minimum}–${maximum}.`);
  return Math.round(result);
}

// The production adapter intentionally does not attach to named custom material
// subclasses. Keep genuine stock UBO declarations isolated from Slate's adapter.
class StockLatticeReferenceMaterial extends StandardMaterial {
  override getClassName(): string { return "StockLatticeReferenceMaterial"; }
}

/**
 * Caller must opt in (the e2e host uses BL_PERF_LATTICE=1). Defaults are one
 * 16,384-vertex mesh, three cage sizes, five modes, two repeats, 10s warmup +
 * 30s measurement per case: about twenty minutes per backend. Smaller explicit
 * options are useful for harness smoke checks, not hardware qualification.
 */
export async function runLatticeDeformerCost(backend: "webgl2" | "webgpu", options: LatticeDeformerCostOptions = {}) {
  const vertexCounts = [...new Set(options.vertexCounts ?? [16384])];
  const resolutions = [...new Set(options.resolutions ?? [2, 3, 4])];
  if (!vertexCounts.length || vertexCounts.some((count) => count !== 16384 && count !== 65536)) throw new Error("Lattice cost accepts 16,384 or 65,536 vertices.");
  if (!resolutions.length || resolutions.some((count) => count !== 2 && count !== 3 && count !== 4)) throw new Error("Lattice cost accepts 2, 3 or 4 controls per axis.");
  const warmupMs = bounded(options.warmupMs, 10_000, 0, 30_000, "warmupMs");
  const sampleMs = bounded(options.sampleMs, 30_000, 250, 120_000, "sampleMs");
  const repetitions = bounded(options.repetitions, 2, 1, 3, "repetitions");
  const width = bounded(options.width, 640, 64, 2048, "width");
  const height = bounded(options.height, 360, 64, 2048, "height");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const progress = document.createElement("pre"); progress.dataset.testid = "lattice-deformer-cost-progress";
  const host = document.getElementById("root")!; host.append(canvas, progress);
  const started = performance.now();
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { stencil: true });
  engine.setSize(width, height); requestRenderPath(engine, { renderPath: "forward" });
  // Pinned Babylon whole-frame WebGPU timestamps use an obsolete encoder API.
  // A WebGPU timestamp-query capability alone does not make these timings valid.
  const instrument = !engine.isWebGPU && engine.getCaps().timerQuery ? new EngineInstrumentation(engine) : null;
  if (instrument) instrument.captureGPUFrameTime = true;
  const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
  const measurements: Array<{
    mode: Mode; requestedVertices: number; vertices: number; triangles: number; resolution: number; controls: number; repeat: number;
    warmupFrames: number; elapsedSampleMs: number; controlUpdates: number;
    cpuSubmissionMs: ReturnType<typeof distribution>; controlUpdateMs: ReturnType<typeof distribution>;
    frameIntervalMs: ReturnType<typeof distribution>; gpuMs?: ReturnType<typeof distribution>;
    gpuStatus: "available" | "no-valid-samples" | "unsupported";
    samples: { cpuSubmissionMs: number[]; controlUpdateMs: number[]; frameIntervalMs: number[]; gpuMs?: number[] };
  }> = [];
  try {
    for (const vertexCount of vertexCounts) for (const resolution of resolutions) for (let repeat = 0; repeat < repetitions; repeat++) {
      // Rotate mode order between repetitions to expose order/thermal variance.
      const order = [...modes.slice(repeat), ...modes.slice(0, repeat)];
      for (const mode of order) {
        const scene = new Scene(engine); scene.clearColor = new Color4(0.05, 0.05, 0.05, 1);
        const renderer = new SceneRenderCoordinator(scene);
        const camera = new FreeCamera("Lattice Cost Camera", new Vector3(0, 3, -3), scene);
        camera.setTarget(Vector3.Zero()); scene.activeCamera = camera;
        new HemisphericLight("Lattice Cost Light", new Vector3(0.2, 1, -0.5), scene);
        const adapted = mode.startsWith("adapted");
        const material = adapted ? new StandardMaterial("Adapted Cost Surface", scene) : new StockLatticeReferenceMaterial("Stock Cost Surface", scene);
        material.diffuseColor = new Color3(0.6, 0.6, 0.6); material.specularColor = Color3.Black();
        const mesh = MeshBuilder.CreateGround("Lattice Cost Geometry", { width: 2, height: 2, subdivisions: Math.sqrt(vertexCount) - 1 }, scene);
        mesh.material = material;
        const config = { enabled: true, strength: 1, resolution: [resolution, resolution, resolution] as [number, number, number],
          fitToMesh: false, boundsMin: [-1.1, -1.1, -1.1] as [number, number, number], boundsMax: [1.1, 1.1, 1.1] as [number, number, number],
          offsets: Array<number>(resolution ** 3 * 3).fill(0) };
        const changing = mode.endsWith("changing");
        let lattice: Lattice | undefined;
        let plugin: LatticePluginMaterial | undefined;
        let controlUpdates = 0;
        const setOffsets = (time: number) => {
          const amplitude = 0.08 + 0.04 * Math.sin(time / 1000);
          for (let z = 0; z < resolution; z++) for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
            const index = 3 * (x + resolution * (y + resolution * z));
            config.offsets[index + 1] = amplitude * (x / (resolution - 1) - 0.5);
          }
        };
        const apply = (time: number) => {
          setOffsets(time);
          if (adapted) setMeshLatticeDeformer(mesh, config);
          else if (lattice) {
            lattice.update();
            for (let z = 0; z < resolution; z++) for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
              lattice.data[x]![y]![z]!.y += config.offsets[3 * (x + resolution * (y + resolution * z)) + 1]!;
            }
            plugin?.refreshData();
          }
          controlUpdates++;
        };
        try {
          if (mode !== "baseline") {
            if (!adapted) lattice = new Lattice({ resolutionX: resolution, resolutionY: resolution, resolutionZ: resolution, size: new Vector3(2.2, 2.2, 2.2) });
            apply(0);
            if (lattice) plugin = new LatticePluginMaterial(lattice, material);
          }
          progress.textContent = JSON.stringify({ backend, mode, vertexCount, resolution, repeat, phase: "warmup", completedCases: measurements.length });
          renderer.invalidate(); await renderer.prepare();
          const draw = (time: number) => {
            const begin = performance.now();
            if (changing) apply(time);
            const updated = performance.now();
            engine.beginFrame();
            try {
              const result = renderer.render();
              if (!result.rendered || !result.readyForPresentation || result.path !== "frameGraph") throw new Error("Lattice cost sample requires a ready production FrameGraph frame.");
            } finally { engine.endFrame(); }
            return { cpu: performance.now() - begin, update: updated - begin };
          };
          let warmupFrames = 0;
          const warmupStart = performance.now();
          do { draw(await nextFrame()); warmupFrames++; } while (performance.now() - warmupStart < warmupMs || warmupFrames < 3);
          progress.textContent = JSON.stringify({ backend, mode, vertexCount, resolution, repeat, phase: "sampling", completedCases: measurements.length });
          const cpu: number[] = [], updates: number[] = [], cadence: number[] = [], gpu: number[] = [];
          let previous = await nextFrame();
          let lastGpuCount = instrument?.gpuFrameTimeCounter.count ?? 0;
          const beforeUpdates = controlUpdates;
          const sampleStart = performance.now();
          do {
            if (document.hidden) throw new Error("Lattice cost run became hidden; frame cadence is no longer representative.");
            const now = await nextFrame(); cadence.push(now - previous); previous = now;
            const elapsed = draw(now); cpu.push(elapsed.cpu); updates.push(elapsed.update);
            const counter = instrument?.gpuFrameTimeCounter;
            if (counter && counter.count > lastGpuCount) {
              lastGpuCount = counter.count;
              if (Number.isFinite(counter.current) && counter.current > 0) gpu.push(counter.current / 1_000_000);
            }
          } while (performance.now() - sampleStart < sampleMs);
          measurements.push({ mode, requestedVertices: vertexCount, vertices: mesh.getTotalVertices(), triangles: mesh.getTotalIndices() / 3,
            resolution, controls: resolution ** 3, repeat, warmupFrames, elapsedSampleMs: performance.now() - sampleStart,
            controlUpdates: controlUpdates - beforeUpdates, cpuSubmissionMs: distribution(cpu), controlUpdateMs: distribution(updates),
            frameIntervalMs: distribution(cadence), ...(gpu.length ? { gpuMs: distribution(gpu) } : {}),
            gpuStatus: !instrument ? "unsupported" : gpu.length ? "available" : "no-valid-samples",
            samples: { cpuSubmissionMs: cpu, controlUpdateMs: updates, frameIntervalMs: cadence, ...(gpu.length ? { gpuMs: gpu } : {}) } });
        } finally {
          disposeMeshLatticeDeformer(mesh);
          await renderer.retire();
          scene.dispose();
        }
      }
    }
    const result = {
      requestedBackend: backend,
      effectiveBackend: engine.isWebGPU ? "webgpu" : engine instanceof Engine && engine.webGLVersion === 2 ? "webgl2" : "webgl1",
      adapter: engine.getInfo(), userAgent: navigator.userAgent, devicePixelRatio, elapsedMs: performance.now() - started,
      workload: { vertexCounts, resolutions, modes, warmupMs, sampleMs, repetitions, width, height, samples: 1, dynamicResolution: false,
        nominalDurationMs: vertexCounts.length * resolutions.length * modes.length * repetitions * (warmupMs + sampleMs),
        geometry: "One static subdivided ground, one StandardMaterial draw, no shadow/depth/outline/animation passes" },
      policy: {
        cpuSubmission: "Control updates plus synchronous Engine beginFrame, coordinator render and endFrame; no GPU wait",
        controlUpdate: "Subset of CPU submission, measured separately; unchanged cases do not call either update API",
        gpu: "Fresh asynchronous nonzero whole-engine query results only; absent on unsupported backends including pinned WebGPU",
        frameInterval: "requestAnimationFrame intervals; vsync and main-thread scheduling affect them; not GPU headroom",
        baseline: "No material deformation plugin; stock cases use Babylon LatticePluginMaterial unchanged",
        adapted: "Production post-WPO path including normal correction, world/cage transforms and conservative bounds updates",
        limits: "Synthetic single-pass cost only. A16 hardware, skinned/morph/WPO models and multi-pass scene budgets require separate representative qualification.",
      }, measurements,
    };
    progress.textContent = JSON.stringify({ backend, phase: "complete", completedCases: measurements.length, elapsedMs: result.elapsedMs });
    return result;
  } finally {
    if (instrument) { instrument.captureGPUFrameTime = false; instrument.dispose(); }
    engine.dispose(); canvas.remove();
  }
}

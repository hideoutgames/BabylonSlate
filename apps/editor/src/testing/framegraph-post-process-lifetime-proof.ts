/** Test-build-only native Effect lifetime regression; numeric pixels, no artwork. */
import { Engine, RawTexture, Scene, Texture, type Effect } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { MaterialLibrary, createAppWebGpuEngine } from "@babylonslate/render";
import { addAuthoredPostProcessTasks } from "@babylonslate/render/framegraph-post-process";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";

async function until(predicate: () => boolean, description: string) {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
}

export async function runPostProcessLifetimeProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 4;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { disableWebGL2Support: false });
  let phase = "setup";
  const effects = new Set<Effect>();
  const createEffect = engine.createEffect;
  engine.createEffect = function (...args) {
    const effect = createEffect.apply(this, args);
    effects.add(effect);
    return effect;
  };
  const invalidPrograms: unknown[] = [];
  if (backend === "webgl2") {
    const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
    const query = gl.getProgramParameter;
    gl.getProgramParameter = function (program, parameter) {
      if (!this.isProgram(program)) invalidPrograms.push({
        phase, parameter, stack: new Error().stack,
        effects: [...effects].filter((effect) =>
          (effect.getPipelineContext() as unknown as { program?: WebGLProgram })?.program === program).map((effect) => ({
            key: effect.key, disposed: effect.isDisposed,
            pipelineDisposed: (effect.getPipelineContext() as unknown as { _isDisposed?: boolean })?._isDisposed,
          })),
      });
      return query.call(this, program, parameter);
    };
  }
  const scene = new Scene(engine);
  const library = new MaterialLibrary();
  const owners: Array<{ graph: FrameGraph; stack: ReturnType<typeof addAuthoredPostProcessTasks> }> = [];
  const diagnostics: string[] = [];
  const retired: Array<{ effect: Effect; pending: boolean; lateProbes: number; compiledAfterRetirement: boolean }> = [];
  const captures: Array<{ action: string; pixel: number[] }> = [];
  const lifetime = { retainedPasses: -1, retainedMaterials: -1, retainedScenes: -1 };
  try {
    // A 256-byte row also avoids native WebGPU readback padding ambiguity.
    const pixels = new Uint8Array(64 * 4 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4)
      pixels.set([160, 80, 40, 255], offset);
    const source = RawTexture.CreateRGBATexture(pixels, 64, 4, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    source.gammaSpace = false;
    const makeOwner = () => {
      const graph = new FrameGraph(scene);
      const sourceTexture = graph.textureManager.importTexture("Numeric Source", source.getInternalTexture()!);
      const stack = addAuthoredPostProcessTasks({
        frameGraph: graph, library, sourceTexture,
        stack: [{ materialGuid: `owner-${owners.length}`, enabled: true, order: 0 }],
        documentFor: () => createDefaultMaterialDocument("Lifetime", "postProcess"),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });
      const owner = { graph, stack };
      owners.push(owner);
      return owner;
    };
    const capture = async (action: string, owner: (typeof owners)[number]) => {
      phase = action;
      await until(() => owner.graph.isReady(), `${action} graph readiness`);
      engine.beginFrame();
      try { owner.graph.execute(); } finally { engine.endFrame(); }
      const output = owner.graph.textureManager.getTextureFromHandle(owner.stack.outputTexture)!;
      const data = await engine._readTexturePixels(output, 64, 4);
      captures.push({ action, pixel: Array.from(new Uint8Array(data.buffer, data.byteOffset, 4)) });
    };
    const sibling = makeOwner();
    await sibling.graph.buildAsync(false);
    await capture("sibling-before", sibling);
    const siblingEffect = engine.postProcesses[0]!.getEffect();

    for (const action of ["replace", "dispose"] as const) {
      phase = `${action}-build`;
      const previousPasses = new Set(engine.postProcesses);
      const owner = makeOwner();
      await owner.graph.buildAsync(false);
      const pass = engine.postProcesses.find((candidate) => !previousPasses.has(candidate))!;
      const effect = pass.getEffect();
      const record = { effect, pending: !effect.isReady(), lateProbes: 0, compiledAfterRetirement: false };
      retired.push(record);
      // Observe the real per-Effect native retry without replacing its result,
      // timer or GPU query. It must run its disposal exit after owner retirement.
      const probe = effect as unknown as { _isReadyInternal(): boolean };
      const ready = probe._isReadyInternal;
      probe._isReadyInternal = function (this: Effect) {
        if (this.isDisposed) record.lateProbes++;
        return ready.call(this);
      };
      if (record.pending) effect.executeWhenCompiled(() => {
        record.compiledAfterRetirement = effect.isDisposed;
      });
      phase = `${action}-retire`;
      if (action === "replace") {
        await owner.stack.tasks[0]!.replaceDocument(createDefaultMaterialDocument("Replacement", "postProcess"));
        await capture("replacement", owner);
      } else {
        owner.stack.dispose();
        owner.graph.dispose();
      }
      if (record.pending) await until(() => record.lateProbes > 0, `${action} native retry disposal exit`);
      if (!effect.isDisposed || effect.isReady()) throw new Error(`${action} retained a ready retired Effect`);
      if (siblingEffect.isDisposed) throw new Error(`${action} retired the sibling Effect`);
      await capture(`sibling-after-${action}`, sibling);
    }
    return {
      backend, captures, diagnostics, lifetime, invalidPrograms,
      retired: retired.map(({ pending, lateProbes, compiledAfterRetirement }) => ({ pending, lateProbes, compiledAfterRetirement })),
      siblingReady: siblingEffect.isReady(),
    };
  } finally {
    phase = "final-cleanup";
    for (const owner of owners) { owner.stack.dispose(); owner.graph.dispose(); }
    library.dispose();
    scene.dispose();
    lifetime.retainedPasses = engine.postProcesses.length;
    lifetime.retainedMaterials = scene.materials.length;
    lifetime.retainedScenes = engine.scenes.length;
    engine.dispose();
    canvas.remove();
  }
}

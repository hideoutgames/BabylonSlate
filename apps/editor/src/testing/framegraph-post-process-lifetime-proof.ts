/** Test-build-only native Effect lifetime regression; numeric pixels, no artwork. */
import { Engine, EngineStore, RawTexture, Scene, Texture, type Effect } from "@babylonjs/core";
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

function gainDocument(gain: number) {
  const document = createDefaultMaterialDocument("Lifetime", "postProcess");
  document.nodes.push(
    { id: "gain", type: "const.float", properties: { value: [gain] }, position: { x: 0, y: 0 } },
    { id: "multiply", type: "math.multiply", properties: {}, position: { x: 0, y: 0 } },
  );
  document.edges = document.edges.filter((edge) => edge.id !== "e-scene-output");
  document.edges.push(
    { id: "source-mul", sourceNodeId: "sceneColor", sourcePinId: "color", targetNodeId: "multiply", targetPinId: "a" },
    { id: "gain-mul", sourceNodeId: "gain", sourcePinId: "out", targetNodeId: "multiply", targetPinId: "b" },
    { id: "mul-output", sourceNodeId: "multiply", sourcePinId: "out", targetNodeId: "output", targetPinId: "color" },
  );
  return document;
}

export async function runPostProcessLifetimeProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 4;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { disableWebGL2Support: false });
  const scene = new Scene(engine);
  const library = new MaterialLibrary();
  const owners: Array<{ graph: FrameGraph; stack: ReturnType<typeof addAuthoredPostProcessTasks> }> = [];
  const diagnostics: string[] = [];
  const retired: Array<{ effect: Effect; pending: boolean; lateProbes: number; compiledAfterRetirement: boolean; completedWhileRetained: boolean; referencesBefore: number }> = [];
  const captures: Array<{ action: string; pixel: number[] }> = [];
  const lifetime = { retainedPasses: -1, retainedMaterials: -1, retainedScenes: -1 };
  const run = async () => {
    // A 256-byte row also avoids native WebGPU readback padding ambiguity.
    const pixels = new Uint8Array(64 * 4 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4)
      pixels.set([160, 80, 40, 255], offset);
    const source = RawTexture.CreateRGBATexture(pixels, 64, 4, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    source.gammaSpace = false;
    const makeOwner = (gain?: number) => {
      const graph = new FrameGraph(scene);
      const sourceTexture = graph.textureManager.importTexture("Numeric Source", source.getInternalTexture()!);
      const stack = addAuthoredPostProcessTasks({
        frameGraph: graph, library, sourceTexture,
        stack: [{ materialGuid: `owner-${owners.length}`, enabled: true, order: 0 }],
        documentFor: () => gain === undefined ? createDefaultMaterialDocument("Lifetime", "postProcess") : gainDocument(gain),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      });
      const owner = { graph, stack };
      owners.push(owner);
      return owner;
    };
    const capture = async (action: string, owner: (typeof owners)[number]) => {
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
      const previousPasses = new Set(engine.postProcesses);
      // Distinct constant shader bodies prevent the ready sibling from warming
      // either retired variant or its replacement through the driver's cache.
      const owner = makeOwner(action === "replace" ? 0.75 : 0.375);
      await owner.graph.buildAsync(false);
      const pass = engine.postProcesses.find((candidate) => !previousPasses.has(candidate))!;
      const effect = pass.getEffect();
      const record = { effect, pending: !effect.isReady(), lateProbes: 0, compiledAfterRetirement: false,
        completedWhileRetained: false, referencesBefore: effect._refCount };
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
        record.completedWhileRetained = !effect.isDisposed;
      });
      if (action === "replace") {
        await owner.stack.tasks[0]!.replaceDocument(gainDocument(0.25));
        await capture("replacement", owner);
      } else {
        owner.stack.dispose();
        owner.graph.dispose();
        await owner.stack.whenDisposed();
      }
      await until(() => effect.isDisposed, `${action} native retirement completion`);
      if (!effect.isDisposed || effect.isReady()) throw new Error(`${action} retained a ready retired Effect`);
      if (siblingEffect.isDisposed) throw new Error(`${action} retired the sibling Effect`);
      await capture(`sibling-after-${action}`, sibling);
    }
    return {
      backend, captures, diagnostics, lifetime,
      engines: EngineStore.Instances.map((candidate, index) => ({ index, proof: candidate === engine })),
      retired: retired.map(({ pending, lateProbes, compiledAfterRetirement, completedWhileRetained, referencesBefore }) =>
        ({ pending, lateProbes, compiledAfterRetirement, completedWhileRetained, referencesBefore })),
      siblingReady: siblingEffect.isReady(),
    };
  };
  const outcome = (await Promise.allSettled([run()]))[0]!;
  {
    for (const owner of owners) { owner.stack.dispose(); owner.graph.dispose(); }
    const cleanup = await Promise.allSettled(owners.map((owner) => owner.stack.whenDisposed()));
    library.dispose();
    scene.dispose();
    lifetime.retainedPasses = engine.postProcesses.length;
    lifetime.retainedMaterials = scene.materials.length;
    lifetime.retainedScenes = engine.scenes.length;
    engine.dispose();
    canvas.remove();
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const errors = failures.map((result) => result.reason);
    if (outcome.status === "rejected") errors.unshift(outcome.reason);
    if (errors.length) throw new AggregateError(errors, "Post-process lifetime proof failed");
  }
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

import { Color4, Engine, FreeCamera, MeshBuilder, PBRMaterial, Scene, Vector3 } from "@babylonjs/core";
import { MaterialLibrary, createAppWebGpuEngine } from "@babylonslate/render";
import { SceneRenderCoordinator } from "@babylonslate/render/scene-render-coordinator";
import { managedLightingReservations } from "@babylonslate/render/managed-lighting-resources";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";

function documentFor(kind: "gain" | "depth" | "normal") {
  const doc = createDefaultMaterialDocument(kind, "postProcess");
  const connect = (source: string, pin: string, target: string, input: string) => doc.edges.push({
    id: `${source}-${pin}-${target}-${input}`, sourceNodeId: source, sourcePinId: pin, targetNodeId: target, targetPinId: input,
  });
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-scene-output");
  if (kind === "gain") {
    doc.nodes.push(
      { id: "gain", type: "param.float", properties: { name: "Gain", value: [0.5] }, position: { x: 0, y: 0 } },
      { id: "multiply", type: "math.multiply", properties: {}, position: { x: 0, y: 0 } },
    );
    connect("gain", "out", "multiply", "b"); connect("sceneColor", "color", "multiply", "a");
    connect("multiply", "out", "output", "color");
  } else {
    doc.nodes.push(
      { id: "buffer", type: kind === "depth" ? "input.sceneDepth" : "input.sceneNormal", properties: {}, position: { x: 0, y: 0 } },
      { id: "combine", type: "vector.combine", properties: {}, position: { x: 0, y: 0 } },
    );
    connect("screenUv", "uv", "buffer", "uv");
    if (kind === "normal") {
      doc.nodes.push({ id: "split", type: "vector.split", properties: {}, position: { x: 0, y: 0 } });
      connect("buffer", "normal", "split", "value");
    }
    for (const channel of ["x", "y", "z"]) connect(kind === "depth" ? "buffer" : "split", kind === "depth" ? "depth" : channel, "combine", channel);
    connect("combine", "xyzw", "output", "color");
  }
  return doc;
}

/** Real production coordinator, without an alternate task construction in the fixture. */
export async function runScenePostProcessCoordinatorProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  const library = new MaterialLibrary();
  const renderer = new SceneRenderCoordinator(scene);
  const camera = new FreeCamera("Scene Camera", new Vector3(0, 0, -4), scene);
  camera.minZ = 1; camera.maxZ = 11; camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  scene.clearColor = new Color4(160 / 255, 80 / 255, 40 / 255, 1);
  const documents = { gain: documentFor("gain"), depth: documentFor("depth"), normal: documentFor("normal") };
  const diagnostics: unknown[] = [];
  const captures: Array<{ name: string; path: string; pixel: number[]; reservedBytes: number }> = [];
  const configure = (stack: Parameters<SceneRenderCoordinator["attachPostProcess"]>[0]["stack"]) => renderer.attachPostProcess({
    scene, camera, library, stack,
    documentFor: (guid) => documents[guid as keyof typeof documents] ?? null,
    onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
  });
  const draw = () => {
    engine.beginFrame();
    try { return renderer.render(); } finally { engine.endFrame(); }
  };
  const capture = async (name: string) => {
    const prepared = await renderer.prepare();
    const result = draw();
    if (!result.rendered || !result.readyForPresentation || prepared.path !== result.path)
      throw new Error(`${name}: unprepared presentation ${JSON.stringify({ prepared, result })}`);
    const bytes = await engine.readPixels(Math.floor(engine.getRenderWidth() / 2), Math.floor(engine.getRenderHeight() / 2), 1, 1);
    captures.push({ name, path: result.path, pixel: Array.from(new Uint8Array(bytes.buffer, bytes.byteOffset, 4)),
      reservedBytes: managedLightingReservations(engine).reservedBytes });
  };
  try {
    engine.setSize(32, 32);
    const attached = configure([
      { id: "first", materialGuid: "gain", enabled: true, order: 0, parameters: { Gain: { kind: "float", value: 0.25 } } },
      { id: "second", materialGuid: "gain", enabled: true, order: 1, parameters: { Gain: { kind: "float", value: 0.75 } } },
    ]);
    const pending = draw();
    if (pending.rendered || pending.readyForPresentation) throw new Error("Pending graph drew an unprocessed scene");
    await capture("duplicates");
    if (!attached.setParameter("first", "Gain", { kind: "float", value: 0.5 })) throw new Error("Entry update rejected");
    await capture("live-value");
    engine.setSize(40, 24);
    await capture("resize-replay");
    await new Promise<void>((resolve) => scene.freezeActiveMeshes(false, resolve));
    await capture("native-fallback");
    scene.unfreezeActiveMeshes();
    await capture("graph-return");
    configure([]);
    await capture("empty");
    const plane = MeshBuilder.CreatePlane("Depth receiver", { size: 4 }, scene);
    plane.material = new PBRMaterial("Native surface", scene);
    configure([{ id: "depth", materialGuid: "depth", enabled: true, order: 0 },
      { id: "normal", materialGuid: "normal", enabled: false, order: 1 }]);
    await capture("depth");
    configure([{ id: "depth", materialGuid: "depth", enabled: true, order: 0 },
      { id: "normal", materialGuid: "normal", enabled: true, order: 1 }]);
    await capture("normal-after-depth");
    await renderer.retire();
    // Natural next frame drains deferred native frees; retirement never forces it.
    await Promise.resolve();
    engine.beginFrame(); engine.endFrame();
    return { backend, adapter: engine.getInfo(), captures, diagnostics,
      finalReservations: managedLightingReservations(engine),
      retainedGraphs: scene.frameGraphs.length, retainedRenderers: scene.objectRenderers.length };
  } finally { await renderer.retire(); library.dispose(); scene.dispose(); engine.dispose(); canvas.remove(); }
}

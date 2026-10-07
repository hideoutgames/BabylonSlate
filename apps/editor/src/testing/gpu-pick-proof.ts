/** Browser oracle: GPU object-ID picking follows shader-displaced geometry. */
import {
  Camera, Color4, Engine, FreeCamera, MeshBuilder, Scene, StandardMaterial, Vector3,
} from "@babylonjs/core";
import {
  compileMaterialPlan, createAppWebGpuEngine, gpuPickMesh, pickAtCanvas, requestRenderPath,
} from "@babylonslate/render";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@babylonslate/shader-graph";

const WIDTH = 240, HEIGHT = 160;
// Orthographic 6 × 4 world units: 40 px per unit, origin at the canvas centre.
const toPixel = (x: number, y: number) => ({ x: WIDTH / 2 + x * 40, y: HEIGHT / 2 - y * 40 });

export async function runGpuPickProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  requestRenderPath(engine, { renderPath: "forward" });
  const scene = new Scene(engine); scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("Pick Camera", new Vector3(0, 0, -8), scene);
  camera.setTarget(Vector3.Zero()); camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -3; camera.orthoRight = 3; camera.orthoTop = 2; camera.orthoBottom = -2;
  camera.minZ = 0.1; camera.maxZ = 30; scene.activeCamera = camera;
  try {
    const plain = MeshBuilder.CreateBox("Plain", { size: 1 }, scene);
    plain.position.x = -2;
    plain.material = new StandardMaterial("Plain Material", scene);

    // Slate node material moving the box 2 units right in the vertex shader.
    const graph = createDefaultMaterialDocument(); graph.shadingModel = "unlit"; graph.boundsPadding = 3;
    graph.nodes.push(
      { id: "shift", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Shift", value: [2] } },
      { id: "offset", type: "vector.combine", position: { x: 0, y: 0 }, properties: {} },
    );
    graph.edges.push(
      { id: "shift-offset", sourceNodeId: "shift", sourcePinId: "out", targetNodeId: "offset", targetPinId: "x" },
      { id: "offset-output", sourceNodeId: "offset", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "worldPositionOffset" },
    );
    const lowered = lowerMaterialDocument(graph);
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "Displaced" });
    if (compiled.ok === false) throw new Error(JSON.stringify(compiled.diagnostics));
    const errors = await compiled.ready; if (errors.length) throw new Error(JSON.stringify(errors));
    const displaced = MeshBuilder.CreateBox("Displaced", { size: 1 }, scene);
    displaced.material = compiled.material;

    await scene.whenReadyAsync();
    // Picks run between frames of the editor's render loop.
    engine.runRenderLoop(() => scene.render());
    for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    const name = (mesh: { name: string } | null | undefined) => mesh === undefined ? "unavailable" : mesh?.name ?? null;
    const at = async (x: number, y: number) => {
      const pixel = toPixel(x, y);
      return {
        gpu: name(await gpuPickMesh(scene, pixel.x, pixel.y)),
        cpu: pickAtCanvas(scene, pixel.x, pixel.y)?.meshName ?? null,
      };
    };
    const result = {
      plain: await at(-2, 0),
      displacedDrawn: await at(2, 0),
      displacedBindPose: await at(0, 0),
      background: await at(0, 1.6),
    };
    compiled.dispose();
    return { effectiveBackend: engine.isWebGPU ? "webgpu" : (engine as Engine).webGLVersion === 2 ? "webgl2" : "webgl1", ...result };
  } finally {
    engine.stopRenderLoop(); scene.dispose(); engine.dispose(); canvas.remove();
  }
}

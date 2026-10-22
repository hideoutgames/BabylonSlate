/** Browser oracle: GPU object-ID picking follows shader-displaced geometry. */
import {
  Camera, Color4, Engine, FreeCamera, MeshBuilder, Scene, StandardMaterial, UtilityLayerRenderer, Vector3, VertexBuffer,
} from "@babylonjs/core";
import {
  compileMaterialPlan, createAppWebGpuEngine, gpuPickMesh, pickAtCanvas, requestRenderPath,
} from "@haptic/render";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";

const WIDTH = 240, HEIGHT = 160;
// Orthographic 6 × 4 world units: 40 px per unit, origin at the canvas centre.
// The perspective camera frames the same 6 × 4 rectangle on the z = 0 plane.
const toPixel = (x: number, y: number) => ({ x: WIDTH / 2 + x * 40, y: HEIGHT / 2 - y * 40 });
const CAMERA_DISTANCE = 8;

/**
 * `bare` is a plain engine and scene. `editor` matches the editor viewport: a floating-origin
 * engine (`useLargeWorldRendering`, always on for WebGPU) and the gizmo's utility layer rendered
 * after the scene every frame, so the last scene to render is not the one being picked.
 */
export type GpuPickProofVariant = "bare" | "editor";

export async function runGpuPickProof(backend: "webgl2" | "webgpu", variant: GpuPickProofVariant = "bare") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: variant === "editor" });
  engine.setSize(WIDTH, HEIGHT);
  requestRenderPath(engine, { renderPath: "forward" });
  const scene = new Scene(engine); scene.clearColor = new Color4(0, 0, 0, 1);
  const camera = new FreeCamera("Pick Camera", new Vector3(0, 0, -CAMERA_DISTANCE), scene);
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

    // Frame corners and edges, where an off-centre pick projection is extreme.
    const box = (name: string, size: number, x: number, y: number, z = 0) => {
      const mesh = MeshBuilder.CreateBox(name, { size }, scene);
      mesh.position.set(x, y, z);
      mesh.material = new StandardMaterial(`${name} Material`, scene);
      return mesh;
    };
    box("Top Left", 0.5, -2.75, 1.75);
    box("Top Right", 0.5, 2.75, 1.75);
    box("Bottom Left", 0.5, -2.75, -1.75);
    // Drawn 2 units right of its bind pose, covering the bottom-right corner.
    const displacedCorner = MeshBuilder.CreateBox("Displaced Corner", { size: 0.5 }, scene);
    displacedCorner.position.set(0.75, -1.75, 0);
    displacedCorner.material = compiled.material;
    // Near is drawn first: only the depth test keeps Far from overwriting it.
    box("Near", 0.6, -2.7, 0, -1);
    box("Far", 1.5, -2.75, 0, 1);

    await scene.whenReadyAsync();
    const gizmoLayer = variant === "editor" ? new UtilityLayerRenderer(scene, true, true) : undefined;
    // Picks run between frames of the editor's render loop.
    engine.runRenderLoop(() => { scene.render(); gizmoLayer?.render(); });
    for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    const name = (mesh: { name: string } | null | undefined) => mesh === undefined ? "unavailable" : mesh?.name ?? null;
    // Every texture the pick allocates; the render loop allocates none once warm.
    const pickTargetSizes = new Set<string>();
    const createTexture = engine._createInternalTexture;
    const at = async (pixel: { x: number; y: number }) => {
      engine._createInternalTexture = function (this: typeof engine, size, ...rest) {
        const { width, height } = typeof size === "number" ? { width: size, height: size } : size;
        pickTargetSizes.add(`${width}x${height}`);
        return createTexture.call(this, size, ...rest);
      } as typeof createTexture;
      try {
        return {
          gpu: name(await gpuPickMesh(scene, pixel.x, pixel.y)),
          cpu: pickAtCanvas(scene, pixel.x, pixel.y)?.meshName ?? null,
        };
      } finally {
        engine._createInternalTexture = createTexture;
      }
    };
    const pickAll = async () => ({
      plain: await at(toPixel(-2, 0)),
      displacedDrawn: await at(toPixel(2, 0)),
      displacedBindPose: await at(toPixel(0, 0)),
      background: await at(toPixel(0, 1.6)),
      topLeft: await at({ x: 0.5, y: 0.5 }),
      topRight: await at({ x: WIDTH - 0.5, y: 0.5 }),
      bottomLeft: await at({ x: 0.5, y: HEIGHT - 0.5 }),
      bottomRightDisplaced: await at({ x: WIDTH - 0.5, y: HEIGHT - 0.5 }),
      displacedCornerBindPose: await at(toPixel(0.75, -1.75)),
      leftEdgeOccluded: await at({ x: 0.5, y: HEIGHT / 2 + 0.5 }),
    });
    const orthographic = await pickAll();
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    camera.fov = 2 * Math.atan(2 / CAMERA_DISTANCE);
    for (let frame = 0; frame < 2; frame++) await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    const perspective = await pickAll();
    // In-place changes between taps, with no frame in between and no signal the pick listens to:
    // the next tap must still draw the changed mesh instead of selecting what lies behind it.
    const plainPixel = toPixel(-2, 0);
    const plainMaterial = plain.material as StandardMaterial;
    const before = await at(plainPixel);
    plainMaterial.markDirty(true);
    const afterMarkDirty = await at(plainPixel);
    plain.setVerticesData(VertexBuffer.ColorKind, new Float32Array(plain.getTotalVertices() * 4).fill(1));
    plain.useVertexColors = true;
    const afterVertexColors = await at(plainPixel);
    const result = { orthographic, perspective, inPlace: { before, afterMarkDirty, afterVertexColors }, pickTargetSizes: [...pickTargetSizes] };
    compiled.dispose();
    return {
      effectiveBackend: engine.isWebGPU ? "webgpu" : (engine as Engine).webGLVersion === 2 ? "webgl2" : "webgl1",
      floatingOriginWithGizmoLayer: scene.floatingOriginMode && !!gizmoLayer?.utilityLayerScene.floatingOriginMode,
      ...result,
    };
  } finally {
    engine.stopRenderLoop(); scene.dispose(); engine.dispose(); canvas.remove();
  }
}

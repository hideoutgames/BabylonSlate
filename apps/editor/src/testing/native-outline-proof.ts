/** Qualification fixture only. No production renderer or authored settings change. */
import {
  Camera, Color3, Color4, Engine, FreeCamera, MeshBuilder, Scene,
  StandardMaterial, Vector3,
} from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { backbufferColorTextureHandle, backbufferDepthStencilTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphSelectionOutlineLayerTask } from "@babylonjs/core/FrameGraph/Tasks/Layers/selectionOutlineTask";
import { ThinSelectionOutlineLayer } from "@babylonjs/core/Layers/thinSelectionOutlineLayer";
import { createAppWebGpuEngine } from "@babylonslate/render";

export async function runNativeOutlineProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 96;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true, stencil: true, disableWebGL2Support: false,
  });
  const scene = new Scene(engine);
  const graph = new FrameGraph(scene);
  const captures: Array<{ name: string; redPixels: number; selectionBuffer: boolean; image: string }> = [];
  try {
    const camera = new FreeCamera("outline qualification", new Vector3(0, 0, -5), scene);
    camera.setTarget(Vector3.Zero());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -2; camera.orthoRight = 2;
    camera.orthoTop = 1.5; camera.orthoBottom = -1.5;
    camera.minZ = 0.1; camera.maxZ = 20;
    scene.activeCamera = camera;
    const material = new StandardMaterial("unlit receiver", scene);
    material.disableLighting = true;
    material.emissiveColor = new Color3(0.25, 0.25, 0.25);
    const source = MeshBuilder.CreateBox("shared source", { size: 0.8 }, scene);
    source.material = material;
    source.position.x = 100;
    const left = source.createInstance("CEL actor");
    left.position.x = -0.8;
    const right = source.createInstance("component actor");
    right.position.x = 0.8;
    const selected = MeshBuilder.CreateBox("selected actor", { size: 0.3 }, scene);
    selected.material = material;
    selected.position.y = 1;

    const clear = new FrameGraphClearTextureTask("clear", graph);
    clear.targetTexture = backbufferColorTextureHandle;
    clear.depthTexture = backbufferDepthStencilTextureHandle;
    clear.color = new Color4(0, 0, 0, 1);
    clear.clearDepth = true;
    graph.addTask(clear);
    const objects = new FrameGraphObjectRendererTask("world", graph, scene);
    objects.targetTexture = clear.outputTexture;
    objects.depthTexture = clear.outputDepthTexture;
    objects.camera = camera;
    objects.objectList = { meshes: [source, left, right, selected], particleSystems: [] };
    graph.addTask(objects);
    let output = objects.outputTexture;
    const layer = (name: string, color: Color3) => {
      // Isolate buffer ownership from occlusion; this does not qualify CEL X-ray.
      const task = new FrameGraphSelectionOutlineLayerTask(name, graph, scene, { useDepthOcclusion: false });
      task.targetTexture = output;
      task.objectRendererTask = objects;
      task.layer.outlineColor = color;
      task.layer.outlineThickness = 2;
      graph.addTask(task);
      output = task.outputTexture;
      return task;
    };
    const cel = layer("CEL", new Color3(1, 0, 0));
    const component = layer("component", new Color3(0, 0, 1));
    const selection = layer("selection", new Color3(0, 1, 0));
    cel.layer.addSelection(left);
    selection.layer.addSelection(selected);
    await graph.buildAsync();
    const capture = async (name: string) => {
      const deadline = performance.now() + 10_000;
      while (!graph.isReady()) {
        if (performance.now() > deadline) throw new Error(`Outline readiness timed out: ${name}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      // The first native layer draw may finish asynchronous effect preparation.
      // Warm the same membership before measuring the presented bitmap.
      for (let frame = 0; frame < 3; frame++) {
        scene.updateTransformMatrix();
        engine.beginFrame();
        try { graph.execute(); } finally { engine.endFrame(); }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      // Capture the presented bitmap on both APIs, including WebGPU BGRA output.
      const copy = document.createElement("canvas");
      copy.width = canvas.width; copy.height = canvas.height;
      const context = copy.getContext("2d")!;
      context.drawImage(canvas, 0, 0);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      let redPixels = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i]! > 200 && pixels[i + 1]! < 30 && pixels[i + 2]! < 30) redPixels++;
      captures.push({
        name, redPixels,
        selectionBuffer: !!source.getVertexBuffer(ThinSelectionOutlineLayer.InstanceSelectionIdAttributeName),
        image: copy.toDataURL("image/png"),
      });
    };
    await capture("CEL and selection");
    component.layer.addSelection(right);
    await capture("all three consumers");
    component.layer.clearSelection();
    await capture("component cleared, CEL retained");
    const reference = captures[0]!;
    const after = captures[2]!;
    return {
      backend, babylonVersion: Engine.Version, width: canvas.width, height: canvas.height,
      userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
      maskType: cel.layer._options.mainTextureType,
      captures,
      blockers: [
        ...(!after.selectionBuffer ? ["Clearing a disjoint component consumer deletes the shared CEL instance selection buffer."] : []),
        ...(after.redPixels < reference.redPixels ? ["The unchanged CEL consumer loses rendered outline pixels after another consumer clears."] : []),
      ],
    };
  } finally {
    for (const task of graph.tasks) task.dispose();
    graph.dispose();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}

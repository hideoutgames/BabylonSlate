/** Test-build-only pixel proof for ScrollBox clipping on both GPU backends. */
import { Camera, Color3, Color4, Engine, FreeCamera, Mesh, MeshBuilder, RenderTargetTexture, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { applyEditorLayoutClips, createAppWebGpuEngine, flipReadPixelsRgba, OverlayLayoutRenderer } from "@babylonslate/render";
import type { OverlayLayoutEntry } from "@babylonslate/core";

export async function runOverlayLayoutProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: false });
  engine.setSize(128, 128);
  const captures: Array<{ host: string; target: string; inside: number[]; outsideY: number[]; outsideX: number[]; marker: number[] }> = [];
  try {
    for (const host of ["editor", "runtime"] as const) {
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0, 0, 0, 1);
      const camera = new FreeCamera("Overlay Camera", new Vector3(0, 0, -2), scene);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = camera.orthoBottom = -1;
      camera.orthoRight = camera.orthoTop = 1;
      scene.activeCamera = camera;
      const root = new Mesh(host === "editor" ? "editorActor:content" : "actor-1", scene);
      // Imported content can have TransformNodes between the layout owner and
      // rendered meshes. Clipping must cross the same hierarchy as picking.
      const transform = new TransformNode("Imported Group", scene);
      transform.parent = root;
      const fill = MeshBuilder.CreatePlane("Content", { size: 2 }, scene);
      fill.parent = transform;
      const red = new StandardMaterial("Content Red", scene);
      red.disableLighting = true; red.emissiveColor = new Color3(1, 0, 0);
      fill.material = red;
      const marker = MeshBuilder.CreatePlane("Unclipped Marker", { size: 0.25 }, scene);
      marker.position.set(-0.75, -0.75, 0);
      marker.renderingGroupId = 1;
      const green = new StandardMaterial("Marker Green", scene);
      green.disableLighting = true; green.emissiveColor = new Color3(0, 1, 0);
      marker.material = green;
      const entry: OverlayLayoutEntry = { actorId: "content", rect: { x: 0, y: 0, width: 2, height: 2 },
        clip: { x: 0, y: 0.45, width: 1, height: 0.5 }, scrollAncestors: ["scroll"] };
      const renderer = new OverlayLayoutRenderer(() => scene);
      if (host === "editor") applyEditorLayoutClips(scene, new Map([["content", entry]]));
      else renderer.apply({ type: "sceneLayerLayout", layerId: "hud", entries: [{ ...entry, slotId: 1 }] });
      let target: RenderTargetTexture | null = null;
      try {
        await red.forceCompilationAsync(fill);
        await green.forceCompilationAsync(marker);
        await scene.whenReadyAsync();
        for (const mode of ["canvas", "rtt"] as const) {
          if (mode === "rtt") {
            target = new RenderTargetTexture("Layer Postprocess Input", 128, scene, false);
            camera.outputRenderTarget = target;
          }
          engine.beginFrame(); scene.render(); engine.endFrame();
          const view = target ? await target.readPixels() : await engine.readPixels(0, 0, 128, 128);
          if (!view) throw new Error("Overlay readback returned no pixels");
          const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          const format = (engine.getCreationOptions() as { swapChainFormat?: string }).swapChainFormat;
          if (!target && backend === "webgpu" && format === "bgra8unorm") {
            for (let i = 0; i < bytes.length; i += 4) [bytes[i], bytes[i + 2]] = [bytes[i + 2]!, bytes[i]!];
          }
          // Ordinary RTTs have bottom-up rows on both engines. The WebGPU
          // canvas is top-down; WebGL readPixels remains bottom-up.
          const upright = target || backend === "webgl2" ? flipReadPixelsRgba(bytes, 128, 128) : bytes;
          const pixel = (x: number, y: number) => Array.from(upright.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 3));
          captures.push({ host, target: mode, inside: pixel(64, 32), outsideY: pixel(64, 96), outsideX: pixel(10, 32), marker: pixel(16, 112) });
        }
      } finally {
        camera.outputRenderTarget = null;
        renderer.dispose(); target?.dispose(); scene.dispose();
      }
    }
    return { backend, captures };
  } finally {
    engine.dispose(); canvas.remove();
  }
}

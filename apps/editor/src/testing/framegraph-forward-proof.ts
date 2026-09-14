/** Test-build-only primitive pixel oracle; no production renderer is selected. */
import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  Material,
  MeshBuilder,
  PBRMaterial,
  RawTexture,
  RenderTargetTexture,
  Scene,
  Texture,
  Vector3,
} from "@babylonjs/core";
import {
  beginEngineDrawCallFrame,
  compileMaterialPlan,
  createAppWebGpuEngine,
  readEngineDrawCalls,
  setSceneRenderSettings,
} from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";

export async function runFrameGraphForwardProof(backend: "webgl2" | "webgpu" = "webgl2", output: "backbuffer" | "texture" = "backbuffer") {
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 64;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true,
    stencil: true,
    disableWebGL2Support: false,
  });
  const draw = <T>(render: () => T): T => {
    engine.beginFrame();
    try { return render(); } finally { engine.endFrame(); }
  };
  const read = async (target?: RenderTargetTexture) => {
    const pixels = target
      ? await target.readPixels()
      : await engine.readPixels(0, 0, canvas.width, canvas.height);
    if (!pixels) throw new Error("Missing rendered pixels");
    return Array.from(
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );
  };
  // Observe the actual retained canvas bitmap, rather than a WebGPU swapchain
  // texture whose frame lifetime can end while an unrelated RTT is rendering.
  const readCanvas = () => {
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    return Array.from(context.getImageData(0, 0, copy.width, copy.height).data);
  };
  const captures = [];
  const lifecycle = [];
  try {
    for (const mode of ["pbr", "cel"] as const) {
      engine.setSize(80, 64);
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0.04, 0.07, 0.12, 1);
      scene.useConstantAnimationDeltaTime = true;
      const camera = new FreeCamera("primary", new Vector3(0, 1.1, -6), scene);
      camera.setTarget(new Vector3(0, 0.2, 0));
      const secondCamera = new FreeCamera(
        "alternate",
        new Vector3(2, 1.4, -6),
        scene,
      );
      secondCamera.setTarget(new Vector3(0, 0.2, 0));
      scene.activeCamera = camera;
      const target = output === "texture"
        ? new RenderTargetTexture("owned output", { width: 80, height: 64 }, scene, false)
        : undefined;
      target?.createDepthStencilTexture();
      camera.outputRenderTarget = secondCamera.outputRenderTarget = target ?? null;
      new HemisphericLight("fill", Vector3.Up(), scene).intensity = 0.4;
      new DirectionalLight("key", new Vector3(0.4, -1, 0.6), scene).intensity =
        1.4;

      const native = new PBRMaterial("Native Surface", scene);
      native.albedoColor = new Color3(0.8, 0.1, 0.04);
      native.metallic = 0;
      native.roughness = 0.8;
      const box = MeshBuilder.CreateBox("native", { size: 1.4 }, scene);
      box.position.x = -1;
      box.rotation.y = 0.3;
      box.material = native;
      const offscreen = MeshBuilder.CreateBox("offscreen", {}, scene);
      offscreen.position.x = 100;
      offscreen.material = native;

      setSceneRenderSettings(scene, { mode });
      const document = createDefaultMaterialDocument("Graph Surface");
      document.nodes.find((node) => node.id === "baseColor")!.properties.value =
        [0.04, 0.55, 0.15];
      const lower = lowerMaterialDocument(document);
      if (!lower.ok) throw new Error("Surface fixture did not lower");
      const compiled = compileMaterialPlan(lower.plan, {
        scene,
        name: "Graph Surface",
      });
      if (!compiled.ok) throw new Error("Surface fixture did not compile");
      const diagnostics = await compiled.ready;
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error"))
        throw new Error("Surface fixture shader failed");
      const sphere = MeshBuilder.CreateSphere(
        "graph",
        { diameter: 1.5, segments: 12 },
        scene,
      );
      sphere.position.x = 1;
      sphere.material = compiled.material;

      const translucent = new PBRMaterial("Translucent Surface", scene);
      translucent.albedoColor = new Color3(0.1, 0.3, 0.95);
      translucent.metallic = 0;
      translucent.roughness = 1;
      translucent.alpha = 0.45;
      const transparent = MeshBuilder.CreatePlane(
        "transparent",
        { width: 2.4, height: 0.6 },
        scene,
      );
      transparent.position.set(0, -0.3, -1.2);
      transparent.material = translucent;

      // Numeric alpha data catches dropped alpha-test and transparent ordering.
      const mask = RawTexture.CreateRGBATexture(
        new Uint8Array([
          255, 220, 30, 255, 255, 220, 30, 0, 255, 220, 30, 0, 255, 220, 30,
          255,
        ]),
        2,
        2,
        scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
      );
      mask.hasAlpha = true;
      const masked = new PBRMaterial("Masked Surface", scene);
      masked.albedoTexture = mask;
      masked.useAlphaFromAlbedoTexture = true;
      masked.transparencyMode = Material.MATERIAL_ALPHATEST;
      masked.metallic = 0;
      masked.roughness = 1;
      const cutout = MeshBuilder.CreatePlane(
        "masked",
        { width: 1.4, height: 0.7 },
        scene,
      );
      cutout.position.set(0, 0.7, -1.1);
      cutout.material = masked;
      setSceneRenderSettings(scene, { mode });

      let expectedCamera = camera;
      let before = 0;
      let after = 0;
      let cameraFailures = 0;
      scene.onBeforeRenderObservable.add(() => {
        before++;
        if (scene.activeCamera !== expectedCamera) cameraFailures++;
      });
      scene.onAfterRenderObservable.add(() => {
        after++;
        if (scene.activeCamera !== expectedCamera) cameraFailures++;
      });
      const existingRenderers = scene.objectRenderers.length;
      const coordinator = new ForwardSceneFrameGraph(scene);
      const capture = async (name: string) => {
        scene.activeCamera = expectedCamera;
        await scene.whenReadyAsync();
        beginEngineDrawCallFrame(engine);
        draw(() => scene.render(false));
        const classicDraws = readEngineDrawCalls(engine);
        const classic = await read(target);
        engine.restoreDefaultFramebuffer(true);
        beginEngineDrawCallFrame(engine);
        const previousBefore = before;
        const previousAfter = after;
        const prepared = await coordinator.prepare(expectedCamera);
        const readinessDraws = readEngineDrawCalls(engine);
        if (before !== previousBefore || after !== previousAfter)
          throw new Error("Graph readiness consumed a scene frame");
        const result = draw(() => coordinator.render(expectedCamera, false));
        const graphDraws = readEngineDrawCalls(engine);
        const graph = await read(target);
        engine.restoreDefaultFramebuffer(true);
        captures.push({
          name: `${mode}-${name}`,
          classic,
          graph,
          classicDraws,
          graphDraws,
          readinessDraws,
          prepared,
          result,
          width: target?.getSize().width ?? canvas.width,
          height: target?.getSize().height ?? canvas.height,
          frames: [before - previousBefore, after - previousAfter],
          frozen: scene.meshes.every(
            (mesh) => mesh.isWorldMatrixFrozen && mesh.material?.isFrozen,
          ),
        });
      };
      await capture("surface");
      for (const mesh of scene.meshes) {
        mesh.freezeWorldMatrix();
        mesh.material?.freeze();
      }
      await capture("frozen");
      expectedCamera = secondCamera;
      await capture("camera-switched");
      secondCamera.position.x = -2;
      secondCamera.setTarget(new Vector3(0, 0.2, 0));
      await capture("camera-moved");
      engine.setSize(96, 72);
      if (target) {
        target.resize({ width: 96, height: 72 });
        if (!target.depthStencilTexture) target.createDepthStencilTexture();
      }
      await capture("resized");

      const sibling = new Scene(engine);
      sibling.clearColor = new Color4(0.6, 0.2, 0.7, 1);
      sibling.activeCamera = new FreeCamera(
        "sibling",
        new Vector3(0, 0, -4),
        sibling,
      );
      draw(() => sibling.render(false));
      const siblingBefore = target ? readCanvas() : await read();
      await capture("after-sibling");
      const siblingPreservedDuringTarget = target ? readCanvas() : null;
      const color = target?.getInternalTexture();
      const depth = target?.depthStencilTexture;
      coordinator.dispose();
      const targetReferencesAfter = target ? [color?._references, depth?._references] : null;
      const targetAfterDispose = target ? await read(target) : null;
      const classicAfterDispose = target ? (
        draw(() => scene.render(false)), await read(target)
      ) : null;
      // The caller's RTT owns its own ObjectRenderer and must remain usable.
      const retainedRenderers = scene.objectRenderers.length - existingRenderers;
      const retainedGraphs = scene.frameGraphs.length;
      scene.dispose();
      draw(() => sibling.render(false));
      lifecycle.push({
        mode,
        cameraFailures,
        retainedRenderers,
        retainedGraphs,
        siblingBefore,
        siblingAfter: target ? readCanvas() : await read(),
        siblingPreservedDuringTarget,
        targetReferencesAfter,
        targetAfterDispose,
        classicAfterDispose,
      });
      sibling.dispose();
    }
    return { captures, lifecycle, backend, output, info: engine instanceof Engine ? engine.getGlInfo() : engine.getInfo(), webGLVersion: engine instanceof Engine ? engine.webGLVersion : null };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

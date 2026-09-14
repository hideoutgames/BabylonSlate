/** Test-build-only managed-shadow oracle using real primitive scenes and GPU draws. */
import {
  CascadedShadowGenerator,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
  type RenderTargetWrapper,
} from "@babylonjs/core";
import { normalizeShadowSettings } from "@babylonslate/core";
import {
  applyAuthoredLightProperties,
  beginEngineDrawCallFrame,
  compileMaterialPlan,
  createAppWebGpuEngine,
  readEngineDrawCalls,
  setSceneRenderSettings,
} from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import { isSceneFrameReady, withSceneReadinessState } from "@babylonslate/render/scene-perf";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";

export async function runFrameGraphShadowProof(backend: "webgl2" | "webgpu" = "webgl2") {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine = backend === "webgpu" ? await createAppWebGpuEngine(canvas) : new Engine(canvas, false, {
    preserveDrawingBuffer: true,
    stencil: true,
    disableWebGL2Support: false,
  });
  const boundTargets: RenderTargetWrapper[] = [];
  let readinessDrawStacks: string[] | undefined;
  const drawElements = engine.drawElementsType.bind(engine);
  engine.drawElementsType = (...args) => {
    readinessDrawStacks?.push(new Error("Readiness draw").stack ?? "Unknown draw");
    drawElements(...args);
  };
  const bind = engine.bindFramebuffer.bind(engine);
  engine.bindFramebuffer = (target, ...args) => {
    boundTargets.push(target);
    bind(target, ...args);
  };
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return Array.from(
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );
  };
  type Kind = "point" | "spot" | "sun";
  const captures = [];
  const lifecycle = [];
  const fixture = async (mode: "pbr" | "cel", kind: Kind) => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.07, 0.12, 1);
    const camera = new FreeCamera("camera", new Vector3(5, 4, -7), scene);
    camera.setTarget(new Vector3(0, 0.3, 0));
    camera.minZ = 0.1;
    camera.maxZ = 30;
    scene.activeCamera = camera;
    new HemisphericLight("fill", Vector3.Up(), scene).intensity = 0.12;
    const origin = new Vector3(-2, 4, -2);
    const direction = origin.negate().normalize();
    const light =
      kind === "point"
        ? new PointLight("key", origin, scene)
        : kind === "spot"
          ? new SpotLight("key", origin, direction, Math.PI / 2, 1, scene)
          : new DirectionalLight("key", direction, scene);
    const setShadows = (enabled: boolean) =>
      applyAuthoredLightProperties(light, {
        intensity: kind === "sun" ? 2 : 8,
        range: 20,
        outerAngle: 90,
        innerAngle: 60,
        castShadows: enabled,
      });
    setShadows(true);
    const native = new PBRMaterial("native", scene);
    native.albedoColor = new Color3(0.05, 0.55, 0.12);
    native.metallic = 0;
    native.roughness = 1;
    setSceneRenderSettings(scene, {
      mode,
      shadows: normalizeShadowSettings({
        cascades: 2,
        mapSize: 256,
        localMapSize: 256,
        maxLocalLights: 1,
        autoBias: false,
        normalBias: 0.02,
        depthBias: 0.0001,
        distance: 25,
      }),
    });
    const document = createDefaultMaterialDocument("graph");
    document.nodes.find((node) => node.id === "baseColor")!.properties.value = [
      0.05, 0.55, 0.12,
    ];
    const lowered = lowerMaterialDocument(document);
    if (!lowered.ok) throw new Error("Shadow surface did not lower");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "graph",
    });
    if (
      !compiled.ok ||
      (await compiled.ready).some(
        (diagnostic) => diagnostic.severity === "error",
      )
    )
      throw new Error("Shadow surface did not compile");
    const casters = [];
    for (const [index, material] of [native, compiled.material].entries()) {
      const floor = MeshBuilder.CreateGround(
        `receiver-${index}`,
        { width: 3, height: 6 },
        scene,
      );
      floor.position.x = index === 0 ? -1.5 : 1.5;
      floor.material = material;
      const caster = MeshBuilder.CreateBox(
        `caster-${index}`,
        { width: 0.7, depth: 0.7, height: 1.4 },
        scene,
      );
      caster.position.set(index === 0 ? -0.9 : 0.9, 0.7, 0);
      caster.material = material;
      casters.push(caster);
    }
    setSceneRenderSettings(scene);
    const graph = new ForwardSceneFrameGraph(scene);
    const prepared = await graph.prepare(camera);
    if (prepared.path !== "frameGraph") throw new Error(prepared.reason);
    const map = () => light.getShadowGenerator()?.getShadowMap() ?? null;
    const render = async (path: "graph" | "classic", force = false) => {
      // Graph readiness warms its own ObjectRenderer render-pass variants. The
      // independent classic oracle must also be ready on the camera's pass.
      const classicReadyBefore = path === "classic" ? withSceneReadinessState(scene, () => {
        scene.activeCamera = camera;
        engine.currentRenderPassId = camera.renderPassId;
        return isSceneFrameReady(scene);
      }) : null;
      if (path === "classic") await scene.whenReadyAsync(true);
      if (force) map()?.resetRefreshCounter();
      boundTargets.length = 0;
      beginEngineDrawCallFrame(engine);
      const target = map();
      let shadowDraws = 0;
      let shadowBefore = 0;
      const before = target?.onBeforeBindObservable.add(() => {
        shadowBefore = readEngineDrawCalls(engine);
      });
      const after = target?.onAfterUnbindObservable.add(() => {
        shadowDraws += readEngineDrawCalls(engine) - shadowBefore;
      });
      engine.beginFrame();
      let result;
      try {
        result = path === "graph"
          ? graph.render(camera, false)
          : (scene.render(false), { path: "classic" });
      } finally {
        engine.endFrame();
      }
      const draws = readEngineDrawCalls(engine);
      if (before) target?.onBeforeBindObservable.remove(before);
      if (after) target?.onAfterUnbindObservable.remove(after);
      const faces = boundTargets.filter(
        (target) => target === map()?.renderTarget,
      ).length;
      const active = scene.getActiveMeshes();
      return {
        pixels: await read(),
        draws,
        faces,
        shadowDraws,
        classicReadyBefore,
        activeMeshes: active.data
          .slice(0, active.length)
          .map((mesh) => mesh.name),
        result,
      };
    };
    const capture = async (pose: string) => {
      boundTargets.length = 0;
      beginEngineDrawCallFrame(engine);
      readinessDrawStacks = [];
      const prepared = await graph.prepare(camera);
      const readinessStacks = readinessDrawStacks;
      readinessDrawStacks = undefined;
      const readinessDraws = readEngineDrawCalls(engine);
      const readinessFaces = boundTargets.length;
      const currentMap = map();
      const texture = currentMap?.getInternalTexture();
      const graphFrame = await render("graph");
      const classic = await render("classic", true);
      const settled = await render("graph");
      const forceGraph = await render("graph", true);
      captures.push({
        name: `${mode}-${kind}-${pose}`,
        prepared,
        readinessDraws,
        readinessStacks,
        readinessFaces,
        graph: graphFrame,
        classic,
        settled,
        forceGraph,
        width: canvas.width,
        height: canvas.height,
        sameMap:
          currentMap === map() && texture === map()?.getInternalTexture(),
        allocations: scene.textures.filter((texture) => texture.isRenderTarget)
          .length,
        generatorEntries: light.getShadowGenerators()?.size ?? 0,
        cascades:
          light.getShadowGenerator() instanceof CascadedShadowGenerator
            ? (light.getShadowGenerator() as CascadedShadowGenerator)
                .numCascades
            : 0,
      });
      return graphFrame.pixels;
    };
    return {
      scene,
      camera,
      light,
      graph,
      casters,
      map,
      setShadows,
      capture,
      render,
    };
  };
  try {
    for (const mode of ["pbr", "cel"] as const)
      for (const kind of ["point", "spot", "sun"] as const) {
        engine.setSize(96, 72);
        const host = await fixture(mode, kind);
        const initialMap = host.map();
        const initialTexture = initialMap?.getInternalTexture();
        const initial = await host.capture("initial");
        for (const mesh of host.casters) mesh.position.z += 0.6;
        await host.capture("caster-moved");
        if (host.light instanceof DirectionalLight)
          host.light.direction.x += 0.3;
        else host.light.position.x += 1.2;
        await host.capture("light-moved");
        host.camera.position.x -= 0.8;
        host.camera.setTarget(new Vector3(0, 0.3, 0));
        await host.capture("camera-moved");
        engine.setSize(112, 80);
        const shadowed = await host.capture("resized");
        const stableAllocation =
          host.map() === initialMap &&
          host.map()?.getInternalTexture() === initialTexture;
        host.setShadows(false);
        const unshadowed = await host.capture("disabled");
        host.setShadows(true);
        await host.capture("reenabled");
        // Sequential client switching on the same Engine must not render or
        // release the sibling's admitted maps, even while disposing the first.
        const sibling = await fixture(mode, "spot");
        const siblingMap = sibling.map();
        const siblingBefore = await sibling.render("classic", true);
        await host.capture("after-sibling");
        host.graph.dispose();
        const ownedAfterGraphDispose = host.map() !== null;
        const retainedGraphObjects = host.scene.objectRenderers.filter(
          (renderer) => renderer.name === "Forward objects",
        ).length;
        host.scene.dispose();
        const siblingAfter = await sibling.render("classic", true);
        const siblingPreserved = sibling.map() === siblingMap;
        sibling.graph.dispose();
        sibling.scene.dispose();
        engine.setSize(96, 72);
        const reloaded = await fixture(mode, kind);
        const reload = await reloaded.capture("reloaded");
        reloaded.graph.dispose();
        reloaded.scene.dispose();
        lifecycle.push({
          name: `${mode}-${kind}`,
          stableAllocation,
          shadowed,
          unshadowed,
          initial,
          reload,
          ownedAfterGraphDispose,
          retainedGraphObjects,
          siblingPreserved,
          siblingBefore,
          siblingAfter,
          remainingScenes: engine.scenes.length,
        });
      }
    return { backend, info: engine instanceof Engine ? engine.getGlInfo() : engine.getInfo(), webGLVersion: engine instanceof Engine ? engine.webGLVersion : null, captures, lifecycle };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}

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
  RenderTargetTexture,
  Scene,
  SpotLight,
  Vector3,
  type RenderTargetWrapper,
} from "@babylonjs/core";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import {
  normalizeRenderingQuality,
  normalizeShadowSettings,
} from "@babylonslate/core";
import { ClusteredSceneLights } from "@babylonslate/render/clustered-scene-lights";
import {
  applyAuthoredLightProperties,
  beginEngineDrawCallFrame,
  compileMaterialPlan,
  createAppWebGpuEngine,
  readEngineDrawCalls,
  setSceneRenderSettings,
} from "@babylonslate/render";
import { ForwardSceneFrameGraph } from "@babylonslate/render/framegraph-forward-scene";
import {
  isSceneFrameReady,
  withSceneReadinessState,
} from "@babylonslate/render/scene-perf";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";

import {
  limitManagedLightingBytes,
  managedLightingReservations,
} from "@babylonslate/render/managed-lighting-resources";

export async function runFrameGraphShadowProof(
  backend: "webgl2" | "webgpu" = "webgl2",
  output: "backbuffer" | "texture" = "backbuffer",
  options: { clustered?: boolean; constrainedResources?: boolean; handoffs?: boolean } = {},
) {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 72;
  document.getElementById("root")!.append(canvas);
  const engine =
    backend === "webgpu"
      ? await createAppWebGpuEngine(canvas)
      : new Engine(canvas, false, {
          preserveDrawingBuffer: true,
          stencil: true,
          disableWebGL2Support: false,
        });
  const boundTargets: RenderTargetWrapper[] = [];
  let readinessDrawStacks: string[] | undefined;
  const drawElements = engine.drawElementsType.bind(engine);
  engine.drawElementsType = (...args) => {
    readinessDrawStacks?.push(
      new Error("Readiness draw").stack ?? "Unknown draw",
    );
    drawElements(...args);
  };
  const bind = engine.bindFramebuffer.bind(engine);
  engine.bindFramebuffer = (target, ...args) => {
    boundTargets.push(target);
    bind(target, ...args);
  };
  const read = async (target: RenderTargetTexture | null) => {
    const pixels = target
      ? await target.readPixels()
      : await engine.readPixels(0, 0, canvas.width, canvas.height);
    if (!pixels) throw new Error("Missing rendered shadow pixels");
    return Array.from(
      new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    );
  };
  type Kind = "point" | "spot" | "sun";
  const captures = [];
  const lifecycle = [];
  const handoffs = [];
  let graphBuilds = 0;
  const build = FrameGraph.prototype.buildAsync;
  FrameGraph.prototype.buildAsync = function (...args) {
    graphBuilds++;
    return build.apply(this, args);
  };
  const fixture = async (mode: "pbr" | "cel", kind: Kind) => {
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.07, 0.12, 1);
    const camera = new FreeCamera("camera", new Vector3(5, 4, -7), scene);
    camera.setTarget(new Vector3(0, 0.3, 0));
    camera.minZ = 0.1;
    camera.maxZ = 30;
    scene.activeCamera = camera;
    const outputTarget =
      output === "texture"
        ? new RenderTargetTexture(
            "owned shadow output",
            { width: 80, height: 64 },
            scene,
            false,
          )
        : null;
    outputTarget?.createDepthStencilTexture();
    camera.outputRenderTarget = outputTarget;
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
    const extraLights = options.clustered
      ? Array.from({ length: 48 }, (_, index) => {
          const position = new Vector3(index % 2 ? 2 : -2, 3, 1);
          const extra =
            index % 2
              ? new SpotLight(
                  `cluster-${index}`,
                  position,
                  position.negate().normalize(),
                  Math.PI / 2,
                  1,
                  scene,
                )
              : new PointLight(`cluster-${index}`, position, scene);
          applyAuthoredLightProperties(extra, {
            intensity: 0.015,
            range: 20,
            outerAngle: 90,
            innerAngle: 60,
            castShadows: false,
          });
          return extra;
        })
      : [];
    const native = new PBRMaterial("native", scene);
    native.albedoColor = new Color3(0.05, 0.55, 0.12);
    native.metallic = 0;
    native.roughness = 1;
    setSceneRenderSettings(scene, {
      mode,
      ...(options.clustered
        ? {
            quality: normalizeRenderingQuality({
              lighting: {
                localLightMode: "manual",
                maxLocalLights: 64,
              },
            }),
          }
        : {}),
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
    // Native PBR construction queues an RGBD BRDF decode even when CEL will
    // not sample the LUT. Finish fixture asset upload before measuring graph
    // preparation; this decode legitimately draws to its own texture target.
    const textureDeadline = performance.now() + 10_000;
    while (
      scene.environmentBRDFTexture &&
      !scene.environmentBRDFTexture.isReady()
    ) {
      if (performance.now() >= textureDeadline)
        throw new Error("BRDF upload timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    const owner = options.clustered
      ? new ClusteredSceneLights(scene, [light, ...extraLights])
      : undefined;
    const mask = () => owner?.target(camera);
    const graph = new ForwardSceneFrameGraph(scene);
    const prepared = await graph.prepare(camera);
    if (prepared.path !== "frameGraph") throw new Error(prepared.reason);
    const map = () => light.getShadowGenerator()?.getShadowMap() ?? null;
    const render = async (path: "graph" | "classic", force = false) => {
      // Graph readiness warms its own ObjectRenderer render-pass variants. The
      // independent classic oracle must also be ready on the camera's pass.
      const classicReadyBefore =
        path === "classic"
          ? withSceneReadinessState(scene, () => {
              scene.activeCamera = camera;
              engine.currentRenderPassId =
                outputTarget?.renderPassId ?? camera.renderPassId;
              return isSceneFrameReady(scene);
            })
          : null;
      if (path === "classic") await scene.whenReadyAsync(true);
      if (force) map()?.resetRefreshCounter();
      boundTargets.length = 0;
      beginEngineDrawCallFrame(engine);
      const target = map();
      const clusterTarget = mask()?.renderTarget;
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
        result =
          path === "graph"
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
        pixels: await read(outputTarget),
        draws,
        faces,
        shadowDraws,
        maskPasses: boundTargets.filter((target) => target === clusterTarget)
          .length,
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
      const buildsBefore = graphBuilds;
      const preparationStarted = performance.now();
      const prepared = await graph.prepare(camera);
      const preparationMs = performance.now() - preparationStarted;
      const readinessStacks = readinessDrawStacks;
      readinessDrawStacks = undefined;
      const readinessDraws = readEngineDrawCalls(engine);
      const readinessFaces = boundTargets.length;
      const currentMask = mask();
      const maskTexture = currentMask?.getInternalTexture();
      const currentMap = map();
      const texture = currentMap?.getInternalTexture();
      const graphFrame = await render("graph");
      const classic = await render("classic", true);
      const settled = await render("graph");
      const forceGraph = await render("graph", true);
      captures.push({
        name: `${mode}-${kind}-${pose}`,
        prepared,
        preparationMs,
        graphBuilds: graphBuilds - buildsBefore,
        readinessDraws,
        readinessStacks,
        readinessFaces,
        graph: graphFrame,
        classic,
        settled,
        forceGraph,
        width: outputTarget?.getSize().width ?? canvas.width,
        height: outputTarget?.getSize().height ?? canvas.height,
        clusterCount: owner?.status().clustered ?? 0,
        keyContributions:
          Number(scene.lights.includes(light) && light.isEnabled()) +
          scene.lights.filter(
            (entry) =>
              entry instanceof ClusteredLightContainer &&
              entry.lights.includes(light),
          ).length,
        sameMask:
          currentMask === mask() &&
          maskTexture === mask()?.getInternalTexture(),
        sameMap:
          currentMap === map() && texture === map()?.getInternalTexture(),
        allocations: scene.textures.filter(
          (texture) => texture.isRenderTarget && texture !== outputTarget,
        ).length,
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
      owner,
      mask,
      extraLights,
      camera,
      light,
      graph,
      casters,
      map,
      setShadows,
      outputTarget,
      capture,
      render,
    };
  };
  try {
    if (options.handoffs) {
      for (const mode of ["pbr", "cel"] as const) {
        const host = await fixture(mode, "point");
        const origin = host.camera.position.clone();
        const incoming = new PointLight("incoming", new Vector3(40, 4, -2), host.scene);
        applyAuthoredLightProperties(incoming, { intensity: 8, range: 100, castShadows: true });
        await host.capture("handoff-initial");
        // The incoming cube must fit the same shared allowance as the current
        // cube; preparation cannot hide over-budget temporary allocations.
        limitManagedLightingBytes(engine, managedLightingReservations(engine).reservedBytes);
        for (const [index, x] of [40, origin.x, 40, origin.x].entries()) {
          // Respect the production residency interval before each real handoff.
          await new Promise<void>((resolve) => setTimeout(resolve, 300));
          host.camera.position.x = x;
          host.camera.setTarget(new Vector3(0, 0.3, 0));
          await host.capture(`handoff-${index}`);
          const capture = captures.at(-1)!;
          handoffs.push({ mode, index, preparationMs: capture.preparationMs, graphBuilds: capture.graphBuilds,
            active: host.scene.lights.filter((light) => light.getShadowGenerator()).map((light) => light.name),
            allocations: capture.allocations, resources: managedLightingReservations(engine) });
        }
        host.graph.dispose(); host.scene.dispose();
      }
      return { backend, output, info: engine instanceof Engine ? engine.getGlInfo() : engine.getInfo(),
        webGLVersion: engine instanceof Engine ? engine.webGLVersion : null, captures, lifecycle, handoffs };
    }
    if (options.constrainedResources) {
      const first = await fixture("pbr", "spot");
      await first.capture("reserved");
      const before = managedLightingReservations(engine);
      limitManagedLightingBytes(engine, before.reservedBytes);
      const firstMap = first.map();
      const firstMask = first.mask();
      const sibling = await fixture("pbr", "spot");
      await sibling.capture("starved");
      const starved = {
        resources: managedLightingReservations(engine),
        clusterCount: sibling.owner?.status().clustered,
        reason: sibling.owner?.status().fallbackReason,
        shadowMaps: sibling.light.getShadowGenerators()?.size ?? 0,
        ownedMaps: sibling.scene.textures.filter(
          (texture) => texture.isRenderTarget,
        ).length,
        firstMapRetained:
          first.map() === firstMap && first.mask() === firstMask,
      };
      first.graph.dispose();
      first.scene.dispose();
      // Per-owner sync reuses released capacity; it does not revoke a sibling's
      // live map or mutate the authored request in order to fit a new client.
      sibling.owner?.sync();
      await sibling.capture("released-capacity");
      const recovered = {
        resources: managedLightingReservations(engine),
        clusterCount: sibling.owner?.status().clustered,
        shadowMaps: sibling.light.getShadowGenerators()?.size ?? 0,
        ownedMaps: sibling.scene.textures.filter(
          (texture) => texture.isRenderTarget,
        ).length,
      };
      sibling.graph.dispose();
      sibling.scene.dispose();
      return {
        backend,
        output,
        info: engine instanceof Engine ? engine.getGlInfo() : engine.getInfo(),
        webGLVersion: engine instanceof Engine ? engine.webGLVersion : null,
        captures,
        lifecycle,
        resourceProof: {
          before,
          starved,
          recovered,
          disposed: managedLightingReservations(engine),
        },
      };
    }
    for (const mode of ["pbr", "cel"] as const)
      for (const kind of ["point", "spot", "sun"] as const) {
        engine.setSize(96, 72);
        const host = await fixture(mode, kind);
        const initialMask = host.mask();
        const initialMaskTexture = initialMask?.getInternalTexture();
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
        // Keep enough receiver pixels for the positive spot-shadow oracle.
        host.outputTarget?.resize({ width: 128, height: 96 });
        // Explicit sampleable depth is owned separately from RTT resize options.
        host.outputTarget?.createDepthStencilTexture();
        const shadowed = await host.capture("resized");
        const stableAllocation =
          host.map() === initialMap &&
          host.map()?.getInternalTexture() === initialTexture;
        host.setShadows(false);
        const unshadowed = await host.capture("disabled");
        host.setShadows(true);
        await host.capture("reenabled");
        const stableMask =
          host.mask() === initialMask &&
          host.mask()?.getInternalTexture() === initialMaskTexture;
        // Sequential client switching on the same Engine must not render or
        // release the sibling's admitted maps, even while disposing the first.
        const sibling = await fixture(mode, "spot");
        const siblingMap = sibling.map();
        const siblingMask = sibling.mask();
        const siblingBefore = await sibling.render("classic", true);
        await host.capture("after-sibling");
        host.graph.dispose();
        const outputReferences = host.outputTarget
          ? [
              host.outputTarget.getInternalTexture()!._references,
              host.outputTarget.depthStencilTexture!._references,
            ]
          : null;
        const outputUsable = host.outputTarget
          ? host.outputTarget.getInternalTexture()!.isReady &&
            host.outputTarget.depthStencilTexture!.isReady
          : true;
        const ownedAfterGraphDispose = host.map() !== null;
        const maskOwnedAfterGraphDispose = host.mask() === initialMask;
        host.owner?.dispose();
        const liveChildrenAfterOwnerDispose = host.extraLights.filter(
          (light) => !light.isDisposed() && host.scene.lights.includes(light),
        ).length;
        const remainingClusterMaps = host.scene.lights.filter(
          (light) => light instanceof ClusteredLightContainer,
        ).length;
        const retainedGraphObjects = host.scene.objectRenderers.filter(
          (renderer) => renderer.name === "Forward objects",
        ).length;
        host.scene.dispose();
        const siblingAfter = await sibling.render("classic", true);
        const siblingPreserved =
          sibling.map() === siblingMap && sibling.mask() === siblingMask;
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
          stableMask,
          maskOwnedAfterGraphDispose,
          liveChildrenAfterOwnerDispose,
          remainingClusterMaps,
          shadowed,
          unshadowed,
          initial,
          reload,
          ownedAfterGraphDispose,
          outputReferences,
          outputUsable,
          retainedGraphObjects,
          siblingPreserved,
          siblingBefore,
          siblingAfter,
          remainingScenes: engine.scenes.length,
        });
      }
    return {
      backend,
      output,
      info: engine instanceof Engine ? engine.getGlInfo() : engine.getInfo(),
      webGLVersion: engine instanceof Engine ? engine.webGLVersion : null,
      captures,
      lifecycle,
      resourceProof: undefined,
    };
  } finally {
    FrameGraph.prototype.buildAsync = build;
    engine.dispose();
    canvas.remove();
  }
}

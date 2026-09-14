import {
  DirectionalLight,
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { normalizeShadowSettings } from "@babylonslate/core";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { afterEach, expect, it, vi } from "vitest";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import { sceneShadowController } from "./shadow-controller";
import { updateSceneRenderingSettings } from "./render-settings";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

async function fixture(kind: "point" | "spot" | "sun" = "point") {
  const engine = new NullEngine();
  engines.push(engine);
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16 });
  // The installed NullEngine omits the cube attachment and WebGL MRT hooks.
  // Complete only those GPU boundaries; all maps, tasks and refresh gates run.
  const createCube = engine.createRenderTargetCubeTexture.bind(engine);
  engine.createRenderTargetCubeTexture = (...args) => {
    const target = createCube(...args);
    target.setTexture(engine.getLoadedTexturesCache().at(-1)!);
    return target;
  };
  vi.spyOn(engine, "buildTextureLayout").mockImplementation(
    (enabled, backbuffer) =>
      backbuffer
        ? [0x0405]
        : enabled.map((value, index) => (value ? 0x8ce0 + index : 0)),
  );
  vi.spyOn(engine, "bindAttachments").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachment").mockImplementation(() => {});
  vi.spyOn(engine, "restoreSingleAttachmentForRenderTarget").mockImplementation(
    () => {},
  );
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 2, -7), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({
      cascades: 1,
      localMapSize: 256,
      mapSize: 256,
      maxLocalLights: 1,
    }),
  });
  const mesh = MeshBuilder.CreateBox("caster", {}, scene);
  const material = new StandardMaterial("opaque", scene);
  mesh.material = material;
  const light =
    kind === "point"
      ? new PointLight("point", new Vector3(0, 3, -2), scene)
      : kind === "spot"
        ? new SpotLight(
            "spot",
            new Vector3(0, 3, -2),
            new Vector3(0, -1, 0.5),
            Math.PI / 2,
            1,
            scene,
          )
        : new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
  const controller = sceneShadowController(scene);
  controller.register(light, true);
  controller.sync();
  const generator = controller.generator(light)!;
  const map = generator.getShadowMap()!;
  const texture = map.getInternalTexture()!;
  await material.forceCompilationAsync(mesh);
  await generator.forceCompilationAsync();
  let faces = 0;
  const bind = engine.bindFramebuffer.bind(engine);
  const framebuffer = vi
    .spyOn(engine, "bindFramebuffer")
    .mockImplementation((target, ...args) => {
      if (target === map.renderTarget) faces++;
      bind(target, ...args);
    });
  const graph = new ForwardSceneFrameGraph(scene);
  const render = () => {
    const previous = faces;
    expect(graph.render(camera, false)).toEqual({ path: "frameGraph" });
    return faces - previous;
  };
  return {
    engine,
    scene,
    camera,
    mesh,
    light,
    controller,
    generator,
    map,
    texture,
    graph,
    render,
    framebuffer,
    faces: () => faces,
  };
}

it.each(["point", "spot", "sun"] as const)(
  "borrows the admitted %s map without preparation draws, duplicate rendering or ownership transfer",
  async (kind) => {
    const {
      scene,
      camera,
      mesh,
      light,
      controller,
      generator,
      map,
      texture,
      graph,
      render,
      faces,
    } = await fixture(kind);
    const textures = scene.textures.length;
    const references = texture._references;
    expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
    expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
    expect(faces()).toBe(0);
    const count = kind === "point" ? 6 : 1;
    expect(render()).toBe(count);
    expect(render()).toBe(kind === "sun" ? 1 : 0);
    mesh.position.x = 0.4;
    expect(render()).toBe(count);
    light.position.x += 0.5;
    expect(render()).toBe(count);
    expect(controller.generator(light)).toBe(generator);
    expect(generator.getShadowMap()).toBe(map);
    expect(map.getInternalTexture()).toBe(texture);
    expect(texture._references).toBe(references);
    expect(scene.textures).toHaveLength(textures);
    expect(light.getShadowGenerators()?.size).toBe(1);
    graph.dispose();
    expect(texture._references).toBe(references);
    expect(scene.textures).toContain(map);
    expect(controller.generator(light)).toBe(generator);
    map.resetRefreshCounter();
    const previous = faces();
    scene.render(false);
    expect(faces() - previous).toBe(count);
  },
);

it("waits for camera-pass materials as well as graph-pass effects without consuming the first shadow draw", async () => {
  const { scene, engine, camera, mesh, graph, faces, render } =
    await fixture("spot");
  // A material can be ready in the task's own pass while its camera variant is
  // still compiling. Keep the real Babylon readiness path for every other pass.
  const material = mesh.material!;
  const isReady = material.isReadyForSubMesh.bind(material);
  let cameraReady = false;
  let cameraProbed = false;
  mesh.position.x = 100; // Offscreen candidates must still become ready.
  vi.spyOn(material, "isReadyForSubMesh").mockImplementation((...args) => {
    if (engine.currentRenderPassId === camera.renderPassId) {
      cameraProbed = true;
      if (!cameraReady) return false;
    }
    return isReady(...args);
  });
  let prepared = false;
  const preparing = graph.prepare(camera).then((result) => {
    prepared = true;
    return result;
  });
  await vi.waitFor(() => expect(cameraProbed).toBe(true));
  expect(prepared).toBe(false);
  expect(faces()).toBe(0);
  expect(scene.activeCamera).toBe(camera);
  cameraReady = true;
  expect(await preparing).toEqual({ path: "frameGraph" });
  expect(faces()).toBe(0);
  mesh.position.x = 0;
  expect(render()).toBe(1);
  expect(render()).toBe(0);
});

it("rechecks admission after scene callbacks so revoked maps are never rendered or rebound", async () => {
  const {
    scene,
    camera,
    light,
    controller,
    generator,
    map,
    graph,
    render,
    faces,
  } = await fixture();
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  scene.onBeforeRenderObservable.addOnce(() => {
    controller.register(light, false);
    controller.sync();
  });
  expect(render()).toBe(0);
  expect(faces()).toBe(0);
  expect(controller.generator(light)).toBeNull();
  expect(light.getShadowGenerator()).not.toBe(generator);
  expect(scene.textures).not.toContain(map);
  expect(graph.render(camera)).toMatchObject({
    path: "classic",
    reason: expect.stringContaining("preparation"),
  });
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(render()).toBe(0);
  expect(
    scene.textures.filter((texture) => texture.isRenderTarget),
  ).toHaveLength(0);
  graph.dispose();
});

it("retains binding observers on settled frames and refreshes them for camera and admission changes", async () => {
  const { scene, camera, light, controller, graph, render } =
    await fixture("spot");
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  render();
  const renderer = scene.objectRenderers.find(
    (renderer) => renderer.name === "Forward objects",
  )!;
  const before = renderer.onBeforeRenderObservable.observers.slice();
  const after = renderer.onAfterRenderObservable.observers.slice();
  render();
  render();
  expect(renderer.onBeforeRenderObservable.observers).toEqual(before);
  expect(renderer.onAfterRenderObservable.observers).toEqual(after);
  const second = new FreeCamera("second", new Vector3(1, 2, -7), scene);
  second.setTarget(Vector3.Zero());
  expect(graph.render(second, false)).toEqual({ path: "frameGraph" });
  expect(renderer.onBeforeRenderObservable.observers).not.toEqual(before);
  const changedCamera = renderer.onBeforeRenderObservable.observers.slice();
  scene.onBeforeRenderObservable.addOnce(() => {
    controller.register(light, false);
    controller.sync();
  });
  expect(graph.render(second, false)).toEqual({ path: "frameGraph" });
  expect(renderer.onBeforeRenderObservable.observers).not.toEqual(
    changedCamera,
  );
  expect(light.getShadowGenerator()).toBeNull();
  graph.dispose();
});

it("settles the material shadow layout before readiness instead of invalidating the first presented frame", async () => {
  const { scene, camera, mesh, graph } = await fixture("spot");
  const dirty = vi.spyOn(mesh.material!, "markDirty");
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  expect(dirty).toHaveBeenCalled();
  dirty.mockClear();
  expect(graph.render(camera, false)).toEqual({ path: "frameGraph" });
  expect(dirty).not.toHaveBeenCalled();
  expect(scene.activeCamera).toBe(camera);
  graph.dispose();
});

it("skips a later borrowed map revoked by an earlier shadow draw", async () => {
  const { engine, scene, camera, controller, map, graph, framebuffer } =
    await fixture("spot");
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({
      cascades: 1,
      localMapSize: 256,
      maxLocalLights: 2,
    }),
  });
  const second = new SpotLight(
    "second",
    new Vector3(1, 3, -2),
    new Vector3(0, -1, 0.5),
    Math.PI / 2,
    1,
    scene,
  );
  controller.register(second, true);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const secondGenerator = controller.generator(second)!;
  const secondMap = secondGenerator.getShadowMap()!;
  const target = secondMap.renderTarget;
  const bind = framebuffer.getMockImplementation()!;
  let revoked = false;
  let secondBinds = 0;
  framebuffer.mockImplementation((current, ...args) => {
    if (current === target) secondBinds++;
    bind(current, ...args);
    if (!revoked && current === map.renderTarget) {
      revoked = true;
      controller.register(second, false);
      controller.sync();
    }
  });
  expect(graph.render(camera, false)).toEqual({ path: "frameGraph" });
  expect(revoked).toBe(true);
  expect(secondBinds).toBe(0);
  expect(scene.textures).not.toContain(secondMap);
  expect(second.getShadowGenerator()).not.toBe(secondGenerator);
  expect(engine._currentRenderTarget).toBeNull();
  graph.dispose();
});

it("keeps admitted maps alive when the graph build fails", async () => {
  const { scene, camera, light, controller, generator, map, graph } =
    await fixture("spot");
  vi.spyOn(
    FrameGraphObjectRendererTask.prototype,
    "record",
  ).mockImplementationOnce(() => {
    throw new Error("object build failed");
  });
  expect(await graph.prepare(camera)).toEqual({
    path: "classic",
    reason: "object build failed",
  });
  expect(controller.generator(light)).toBe(generator);
  expect(scene.textures).toContain(map);
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  graph.dispose();
  expect(scene.textures).toContain(map);
});

it("restores the borrowed target and scene state when a shadow draw fails, leaving a sibling scene usable", async () => {
  const { engine, scene, camera, map, graph, framebuffer } =
    await fixture("spot");
  expect(await graph.prepare(camera)).toEqual({ path: "frameGraph" });
  const sibling = new Scene(engine);
  sibling.activeCamera = new FreeCamera("sibling", Vector3.Zero(), sibling);
  const bind = framebuffer.getMockImplementation()!;
  framebuffer.mockImplementation((target, ...args) => {
    bind(target, ...args);
    if (target === map.renderTarget)
      throw new Error("shadow framebuffer failed");
  });
  expect(() => graph.render(camera)).toThrow("shadow framebuffer failed");
  expect(engine._currentRenderTarget).toBeNull();
  expect(scene._intermediateRendering).toBe(false);
  expect(scene.activeCamera).toBe(camera);
  expect(scene.frameGraph).toBeNull();
  expect(map._disableEngineStages).toBe(false);
  expect(() => sibling.render()).not.toThrow();
  graph.dispose();
  expect(scene.textures).toContain(map);
});

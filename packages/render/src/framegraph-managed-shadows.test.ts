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

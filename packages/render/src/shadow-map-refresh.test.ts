import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DirectionalLight,
  Material,
  Matrix,
  Mesh,
  MeshBuilder,
  MorphTargetManager,
  NullEngine,
  NullEngineOptions,
  PointLight,
  Scene,
  Skeleton,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { normalizeShadowSettings } from "@babylonslate/core";
import { sceneShadowController } from "./shadow-controller";
import { updateSceneRenderingSettings } from "./render-settings";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

async function fixture(floatingOrigin = false) {
  const options = new NullEngineOptions();
  options.enableMultiview = floatingOrigin;
  const engine = new NullEngine(options);
  engines.push(engine);
  Object.assign(engine.getCaps(), { maxTexturesImageUnits: 16 });
  // Complete Babylon 9.20 NullEngine's missing cube texture/wrapper attachment.
  const createCube = engine.createRenderTargetCubeTexture.bind(engine);
  engine.createRenderTargetCubeTexture = (...args) => {
    const target = createCube(...args);
    target.setTexture(engine.getLoadedTexturesCache().at(-1)!);
    return target;
  };
  const scene = new Scene(engine, { useFloatingOrigin: floatingOrigin });
  const camera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({
      cascades: 1,
      localMapSize: 256,
      maxLocalLights: 1,
    }),
  });
  const added = new Promise<void>((resolve) =>
    scene.onNewMeshAddedObservable.addOnce(() => resolve()),
  );
  const mesh = MeshBuilder.CreateBox("caster", {}, scene);
  const material = new StandardMaterial("opaque", scene);
  mesh.material = material;
  mesh.freezeWorldMatrix();
  const previousGeometryUpdate = vi.fn();
  const geometry = mesh.geometry!;
  geometry.onGeometryUpdated = previousGeometryUpdate;
  const light = new PointLight("local", new Vector3(0, 3, 0), scene);
  const controller = sceneShadowController(scene);
  controller.register(light, true);
  await added;
  controller.sync();
  const generator = controller.generator(light)!;
  const map = generator.getShadowMap()!;
  const faces = vi.fn();
  // RTT readiness also emits per-face render observables. Count real framebuffer
  // bindings instead, including the clears needed after the last caster leaves.
  const bindFramebuffer = engine.bindFramebuffer.bind(engine);
  vi.spyOn(engine, "bindFramebuffer").mockImplementation((target, ...args) => {
    if (target === map.renderTarget) faces();
    bindFramebuffer(target, ...args);
  });
  await material.forceCompilationAsync(mesh);
  await generator.forceCompilationAsync();
  const render = () => {
    const previous = faces.mock.calls.length;
    scene.render();
    return faces.mock.calls.length - previous;
  };
  return {
    scene,
    camera,
    mesh,
    geometry,
    material,
    light,
    controller,
    generator,
    map,
    faces,
    render,
    previousGeometryUpdate,
  };
}

describe("local shadow refresh", () => {
  it("accepts empty mesh roots and refreshes when their submeshes are populated or removed", async () => {
    const { scene, material, controller, map, render } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);

    const pending = new Mesh("pending model root", scene);
    pending.material = material;
    // This is Babylon's real initial state, not an incomplete mesh stub.
    expect(pending.subMeshes).toBeUndefined();
    controller.setParticipation(pending, { castShadows: true });
    expect(render()).toBe(6);
    expect(render()).toBe(6); // Unknown geometry remains conservative.

    VertexData.CreateBox({}).applyToMesh(pending);
    expect(render()).toBe(6);
    expect(map.renderList).toContain(pending);
    expect(render()).toBe(0);

    pending.releaseSubMeshes();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it("renders the first cube after readiness probes, then reuses unchanged content and allocation", async () => {
    const { scene, mesh, light, controller, generator, map, faces, render } =
      await fixture();
    expect(map.isReadyForRendering()).toBe(true);
    expect(map.isReadyForRendering()).toBe(true);
    expect(faces).not.toHaveBeenCalled();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.freezeWorldMatrix(); // same pose with a newly computed matrix revision
    expect(render()).toBe(0);
    const parent = new TransformNode("light parent", scene);
    light.parent = parent;
    expect(render()).toBe(0);
    expect(render()).toBe(0);
    parent.position.x = 2;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(controller.generator(light)).toBe(generator);
  });

  it("invalidates visibility, material depth state, geometry edits and removed casters", async () => {
    const {
      scene,
      mesh,
      geometry,
      material,
      controller,
      generator,
      map,
      render,
      previousGeometryUpdate,
    } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.isVisible = false;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.isVisible = true;
    expect(render()).toBe(6);
    material.backFaceCulling = false;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const positions = [...mesh.getVerticesData(VertexBuffer.PositionKind)!];
    positions[0] = positions[0]! + 1;
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, false);
    expect(previousGeometryUpdate).toHaveBeenCalled();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    controller.setParticipation(mesh, { castShadows: false });
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    controller.setParticipation(mesh, { castShadows: true });
    expect(render()).toBe(6);
    mesh.dispose();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(generator.getShadowMap()).toBe(map);
    expect(geometry.onGeometryUpdated).toBe(previousGeometryUpdate);
    scene.dispose();
  });

  it("retries a map whose caster shader was not ready without another scene change", async () => {
    const { generator, render } = await fixture();
    vi.spyOn(generator, "isReady").mockReturnValueOnce(false);
    expect(render()).toBe(6);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it("refreshes when mesh face orientation controls shadow culling", async () => {
    const { mesh, material, render } = await fixture();
    material.sideOrientation = null;
    mesh.sideOrientation = Material.CounterClockWiseSideOrientation;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    mesh.sideOrientation = Material.ClockWiseSideOrientation;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it.each([false, true])(
    "keeps same-count dynamic index edits live (GPU-only: %s)",
    async (gpuMemoryOnly) => {
      const { mesh, geometry, render, previousGeometryUpdate } =
        await fixture();
      expect(render()).toBe(6);
      expect(render()).toBe(0);
      const indices = [...mesh.getIndices()!];
      mesh.setIndices(indices, null, true);
      expect(render()).toBe(6);
      previousGeometryUpdate.mockClear();
      [indices[0], indices[1]] = [indices[1]!, indices[0]!];
      geometry.updateIndices(indices, 0, gpuMemoryOnly);
      expect(previousGeometryUpdate).not.toHaveBeenCalled();
      expect(render()).toBe(6);
      [indices[0], indices[1]] = [indices[1]!, indices[0]!];
      geometry.updateIndices(indices, 0, gpuMemoryOnly);
      expect(render()).toBe(6);
    },
  );

  it("detects replaced and updated frozen attachment matrices without transform notifications", async () => {
    const { mesh, render } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const world = Matrix.Translation(1, 0, 0);
    mesh.freezeWorldMatrix(world);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    Matrix.TranslationToRef(2, 0, 0, world);
    mesh.freezeWorldMatrix(world);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
  });

  it.each([
    "skeleton",
    "morph",
    "alpha",
    "instances",
    "updatable",
    "unknown",
  ] as const)("keeps %s caster content refreshing", async (kind) => {
    const { scene, mesh, material, render } = await fixture();
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    switch (kind) {
      case "skeleton":
        mesh.skeleton = new Skeleton("rig", "rig", scene);
        break;
      case "morph":
        mesh.morphTargetManager = new MorphTargetManager(scene);
        break;
      case "alpha":
        material.transparencyMode = Material.MATERIAL_ALPHATEST;
        break;
      case "instances":
        mesh.createInstance("moving instance");
        break;
      case "updatable":
        mesh.setVerticesData(
          VertexBuffer.PositionKind,
          mesh.getVerticesData(VertexBuffer.PositionKind)!,
          true,
        );
        break;
      case "unknown": {
        class UnknownMaterial extends StandardMaterial {}
        mesh.material = new UnknownMaterial("custom", scene);
        break;
      }
    }
    expect(render()).toBe(6);
    expect(render()).toBe(6);
  });

  it("invalidates local depth changes while continuing to render camera-dependent sun maps", async () => {
    const { scene, camera, light, controller, generator, render } =
      await fixture();
    const sun = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(sun, true);
    controller.sync();
    const sunlight = controller.generator(sun)!;
    await sunlight.forceCompilationAsync();
    const sunDraw = vi.fn();
    sunlight.getShadowMap()!.onBeforeRenderObservable.add(sunDraw);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    expect(sunDraw).toHaveBeenCalledTimes(2);
    camera.maxZ = 250;
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    camera.position.x += 1;
    expect(render()).toBe(0);
    expect(sunDraw).toHaveBeenCalledTimes(5);
    expect(controller.generator(light)).toBe(generator);
  });

  it("refreshes local maps when the actual floating render origin moves", async () => {
    const { scene, camera, render } = await fixture(true);
    expect(render()).toBe(6);
    expect(render()).toBe(0);
    const oldOrigin = scene.floatingOriginOffset.clone();
    camera.position.x += 1;
    expect(render()).toBe(6);
    expect(scene.floatingOriginOffset.equals(oldOrigin)).toBe(false);
    expect(render()).toBe(0);
  });
});

import {
  DirectionalLight,
  HemisphericLight,
  MaterialHelper,
  MeshBuilder,
  NullEngine,
  NullEngineOptions,
  PBRMaterial,
  PointLight,
  RawTexture,
  Scene,
  ShaderStore,
  SpotLight,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  type Effect,
  type Light,
  type Material,
  type Mesh,
} from "@babylonjs/core";
import { WebGL2ShaderProcessor } from "@babylonjs/core/Engines/WebGL/webGL2ShaderProcessors";
import { lightFragment } from "@babylonjs/core/Shaders/ShadersInclude/lightFragment";
import { normalizeRenderingQuality, normalizeShadowSettings, qualityPresetPatch } from "@babylonslate/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CelMaterial } from "./cel-material";
import {
  fixedLightSlotTable,
  setFixedShapeLightingEnabled,
  setFixedShapeLightingWorldScene,
} from "./fixed-light-admission";
import { emptyLightSeatBuffer, preparePreviousEffectBindings, setFixedShapeLightGuard } from "./fixed-light-binding";
import { existingShadowSamplerPlaceholders } from "./shadow-sampler-placeholders";
import { setAuthoredLightEnabled } from "./light-policy";
import { updateSceneRenderingSettings } from "./render-settings";
import { syncSceneLighting } from "./scene-lighting";
import { sceneShadowController } from "./shadow-controller";
import { withShadowDistanceFade } from "./shadow-shader";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A world Scene on a headless WebGL2 Engine with uniform buffers (nine light slots). */
function world(options: { fixed?: boolean; world?: boolean } = {}) {
  const engineOptions = new NullEngineOptions();
  engineOptions.enableMultiview = true;
  const engine = new NullEngine(engineOptions);
  engines.push(engine);
  // WebGL2's shader processing, so effects hold the source a WebGL2 Engine compiles (inactive #if blocks removed).
  (engine as unknown as { _shaderProcessor: WebGL2ShaderProcessor })._shaderProcessor = new WebGL2ShaderProcessor();
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
  scene.environmentBRDFTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
  vi.spyOn(scene.environmentBRDFTexture, "isReady").mockReturnValue(true);
  if (options.world !== false) setFixedShapeLightingWorldScene(scene);
  if (options.fixed !== false) setFixedShapeLightingEnabled(engine, true);
  return { engine, scene };
}

/** Sun, fill, two spots and two points: seats SUN, FILL, LOCAL_SPOT x2, LOCAL_POINT x2. */
function lightRig(scene: Scene) {
  const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.2), scene);
  const fill = new HemisphericLight("fill", Vector3.Up(), scene);
  const spots = [-2, 2].map((x, index) => new SpotLight(`spot-${index}`, new Vector3(x, 3, 0), Vector3.Down(), 1, 2, scene));
  const points = [-1, 1].map((x, index) => new PointLight(`point-${index}`, new Vector3(x, 2, 1), scene));
  return { sun, fill, spots, points };
}

function frame(scene: Scene) {
  syncSceneLighting(scene);
  scene.incrementRenderId();
}

async function effectOf(material: Material, mesh: Mesh): Promise<Effect> {
  const subMesh = mesh.subMeshes[0]!;
  await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
  return subMesh.effect!;
}

function receivers(scene: Scene) {
  const pbr = new PBRMaterial("native-pbr", scene);
  const standard = new StandardMaterial("native-standard", scene);
  const meshes = [pbr, standard].map((material, index) => {
    const mesh = MeshBuilder.CreateBox(`receiver-${index}`, {}, scene);
    mesh.material = material;
    return mesh;
  });
  return { pbr, standard, meshes, pairs: [[pbr, meshes[0]!], [standard, meshes[1]!]] as const };
}

const compiledEffects = (engine: NullEngine) =>
  Object.keys((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects).sort();

const seatOf = (scene: Scene, light: Light) => fixedLightSlotTable(scene)!.seats.findIndex((seat) => seat.light === light);

describe("fixed-shape light binding", () => {
  it("leaves native materials' defines and shaders Babylon's own while the switch is off", async () => {
    const compile = async (options: { world: boolean; toggled?: boolean }) => {
      const { engine, scene } = world({ fixed: false, world: options.world });
      lightRig(scene);
      const { pairs } = receivers(scene);
      if (options.toggled) {
        // On, then off again: the defines text must come back exactly.
        setFixedShapeLightingEnabled(engine, true);
        frame(scene);
        for (const [material, mesh] of pairs) expect((await effectOf(material, mesh)).defines).toContain("SLATE_FIXED_LIGHTS");
        setFixedShapeLightingEnabled(engine, false);
      }
      frame(scene);
      const effects = [];
      for (const [material, mesh] of pairs) effects.push(await effectOf(material, mesh));
      return effects.map((effect) => ({ defines: effect.defines, fragment: effect.fragmentSourceCode, vertex: effect.vertexSourceCode }));
    };
    const legacy = await compile({ world: false });
    expect(await compile({ world: true })).toEqual(legacy);
    expect(await compile({ world: true, toggled: true })).toEqual(legacy);
    expect(legacy[0]!.defines).not.toContain("SLATE_FIXED");

    // The seat guards compile away without seat defines: the fragment code is
    // what Babylon's include (with Haptic's shadow fade) gives.
    const store = ShaderStore.GetIncludesShadersStore(0);
    const installed = store.lightFragment!;
    store.lightFragment = withShadowDistanceFade(lightFragment.shader, false);
    try {
      expect(await compile({ world: false })).toEqual(legacy);
    } finally {
      store.lightFragment = installed;
    }
  });

  it("compiles one Effect per layout: toggles, seat changes within a class and a new light of the class change bindings only", async () => {
    const { engine, scene } = world();
    const { points, spots } = lightRig(scene);
    // Two more points than the low preset's four local lights.
    const extra = [3, 5].map((x, index) => new PointLight(`extra-${index}`, new Vector3(x, 2, 1), scene));
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("low")) });
    const { pairs } = receivers(scene);
    frame(scene);
    const before: Effect[] = [];
    for (const [material, mesh] of pairs) before.push(await effectOf(material, mesh));
    expect(before[0]!.defines).toContain("#define SLATE_FIXED_LIGHTS");
    const compiled = compiledEffects(engine);
    const unchanged = async (step: string) => {
      frame(scene);
      for (const [index, [material, mesh]] of pairs.entries())
        expect(await effectOf(material, mesh), step).toBe(before[index]);
      expect(compiledEffects(engine), step).toEqual(compiled);
    };

    // The two spots and two of the points hold the four local lights.
    const pointSeat = seatOf(scene, points[0]!);
    expect(pointSeat).toBeGreaterThanOrEqual(0);
    setAuthoredLightEnabled(points[0]!, false);
    await unchanged("a point switched off");
    // Its seat went to a waiting point of the same class.
    expect(extra.map((light) => seatOf(scene, light))).toContain(pointSeat);
    setAuthoredLightEnabled(spots[1]!, false);
    await unchanged("a spot switched off, its seat empty");
    setAuthoredLightEnabled(spots[1]!, true);
    setAuthoredLightEnabled(points[0]!, true);
    await unchanged("both back on");
    spots[0]!.dispose();
    new SpotLight("replacement", new Vector3(0, 3, 2), Vector3.Down(), 1, 2, scene);
    await unchanged("a new spot in the old one's seat");
    scene.activeCamera!.position.set(20, 2, 0);
    await unchanged("the camera ranked other points into the point seats");
  });

  it("samples a spot's shadow in its shadow seat and keeps the Effect when the map hands off to the next spot", async () => {
    const { scene } = world();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }) });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const shadows = sceneShadowController(scene);
    const near = new SpotLight("near", new Vector3(0, 3, 0), Vector3.Down(), 1, 2, scene);
    const far = new SpotLight("far", new Vector3(100, 3, 0), Vector3.Down(), 1, 2, scene);
    for (const light of [near, far]) shadows.register(light, true);
    const { pairs } = receivers(scene);
    const sync = () => {
      syncSceneLighting(scene);
      shadows.sync();
      frame(scene);
    };
    sync();
    // One spot shadow seat (seat 0) and one local spot seat (seat 1).
    expect(fixedLightSlotTable(scene)!.seats.map((seat) => `${seat.classId}:${seat.light?.name}${seat.shadowActive ? " shadowed" : ""}`))
      .toEqual(["SPOT_SHADOW:near shadowed", "LOCAL_SPOT:far"]);
    const before: Effect[] = [];
    for (const [material, mesh] of pairs) {
      const effect = await effectOf(material, mesh);
      expect(effect.defines).toContain("#define SHADOW0\n");
      expect(effect.defines).not.toContain("#define SHADOW1\n");
      before.push(effect);
    }
    clock.mockReturnValue(1_000);
    scene.activeCamera!.position.set(100, 2, -10);
    sync();
    expect(shadows.generator(far)).not.toBeNull();
    expect(fixedLightSlotTable(scene)!.seats.map((seat) => `${seat.light?.name}${seat.shadowActive ? " shadowed" : ""}`))
      .toEqual(["far shadowed", "near"]);
    for (const [index, [material, mesh]] of pairs.entries()) expect(await effectOf(material, mesh)).toBe(before[index]);
  });

  it("guards a seat the layout grows into after Babylon's path had used that light index", async () => {
    const { engine, scene } = world();
    // Two fills: the layout seats one; on Babylon's path both light the Material (LIGHT0, LIGHT1).
    new HemisphericLight("fill", Vector3.Up(), scene);
    new HemisphericLight("second fill", Vector3.Down(), scene);
    const { pairs } = receivers(scene);
    const compile = async (expected: string, present: boolean) => {
      frame(scene);
      for (const [material, mesh] of pairs) {
        const defines = (await effectOf(material, mesh)).defines;
        if (present) expect(defines).toContain(expected);
        else expect(defines).not.toContain(expected);
      }
    };
    await compile("#define LIGHT1\n", false);
    setFixedShapeLightingEnabled(engine, false);
    await compile("#define LIGHT1\n", true);
    setFixedShapeLightingEnabled(engine, true);
    await compile("#define LIGHT1\n", false);
    const lamp = new PointLight("lamp", Vector3.Up(), scene);
    frame(scene);
    expect(seatOf(scene, lamp)).toBe(1);
    for (const [material, mesh] of pairs) {
      const effect = await effectOf(material, mesh);
      expect(effect.defines).toContain("#define POINTLIGHT1\n");
      expect(effect.defines).toContain("#define SLATE_FIXED_LIGHT1\n");
    }
  });

  it("compiles and binds every seat when the layout seats more lights than the Scene now holds", async () => {
    const { scene } = world();
    new DirectionalLight("sun", Vector3.Down(), scene);
    new HemisphericLight("fill", Vector3.Up(), scene);
    const spot = new SpotLight("spot", new Vector3(0, 3, 0), Vector3.Down(), 1, 2, scene);
    new PointLight("point", new Vector3(1, 2, 0), scene);
    const { pairs } = receivers(scene);
    frame(scene);
    // Five lights now, but the spot's seat stays: sun, fill, spot, and three point seats.
    spot.dispose();
    const last = [new PointLight("point 2", new Vector3(-1, 2, 0), scene), new PointLight("point 3", new Vector3(0, 2, 1), scene)][1]!;
    frame(scene);
    expect(seatOf(scene, last)).toBe(5);
    for (const [material, mesh] of pairs) {
      const effect = await effectOf(material, mesh);
      expect(effect.defines).toContain("#define POINTLIGHT5\n");
      expect(effect.fragmentSourceCode).toContain("light5.vLightData");
      const bind = vi.spyOn(effect, "bindUniformBuffer");
      material.bindForSubMesh(mesh.getWorldMatrix(), mesh, mesh.subMeshes[0]!);
      expect(bind.mock.calls.find(([, name]) => name === "Light5")?.[0])
        .toBe((last as unknown as { _uniformBuffer: { getBuffer(): unknown } })._uniformBuffer.getBuffer());
      bind.mockRestore();
    }
  });

  it("binds each seat's light, and a null buffer of the seat's kind to an empty seat", async () => {
    const { engine, scene } = world();
    const { sun, fill, spots, points } = lightRig(scene);
    const { pairs } = receivers(scene);
    frame(scene);
    const [material, mesh] = pairs[0];
    const effect = await effectOf(material, mesh);
    for (const [index, kind] of ["DIRLIGHT", "HEMILIGHT", "SPOTLIGHT", "SPOTLIGHT", "POINTLIGHT", "POINTLIGHT"].entries())
      expect(effect.defines).toContain(`#define ${kind}${index}\n`);
    expect(effect.defines).toContain("#define MAXLIGHTCOUNT 6\n");
    const bound = () => {
      const bind = vi.spyOn(effect, "bindUniformBuffer");
      material.bindForSubMesh(mesh.getWorldMatrix(), mesh, mesh.subMeshes[0]!);
      const calls = new Map(bind.mock.calls.map(([buffer, name]) => [name, buffer]));
      bind.mockRestore();
      return calls;
    };
    const buffer = (light: Light) => (light as unknown as { _uniformBuffer: { getBuffer(): unknown } })._uniformBuffer.getBuffer();
    let calls = bound();
    expect([0, 1, 2, 3, 4, 5].map((index) => calls.get(`Light${index}`))).toEqual(
      [sun, fill, ...spots, ...points].map((light) => buffer(light)),
    );
    setAuthoredLightEnabled(points[1]!, false);
    frame(scene);
    expect(await effectOf(material, mesh)).toBe(effect);
    calls = bound();
    const empty = emptyLightSeatBuffer(engine, "point");
    expect(calls.get("Light5")).toBe(empty.getBuffer());
    expect(calls.get("Light4")).toBe(buffer(points[0]!));
  });

  it("scales each seat by its active flag without a branch, or as chosen behind a uniform branch, and compiles cone math only into spot seats", async () => {
    const { engine, scene } = world();
    lightRig(scene);
    const { pairs } = receivers(scene);
    frame(scene);
    for (const [material, mesh] of pairs) {
      const code = (await effectOf(material, mesh)).fragmentSourceCode;
      for (let seat = 0; seat < 6; seat++) expect(code).toContain(`shadow*=step(0.0,light${seat}.vLightDiffuse.a);`);
      expect(code).not.toContain("vLightDiffuse.a>=0.0");
    }
    const pbr = (await effectOf(...pairs[0])).fragmentSourceCode;
    for (const seat of [2, 3]) expect(pbr).toContain(`computeDirectionalLightFalloff(light${seat}.vLightDirection.xyz`);
    for (const seat of [4, 5]) expect(pbr).not.toContain(`light${seat}.vLightDirection`);
    const standard = (await effectOf(...pairs[1])).fragmentSourceCode;
    expect(standard).toContain("info=computeSpotLighting(viewDirectionW,normalW,light2.vLightData");
    expect(standard).toContain("info=computeLighting(viewDirectionW,normalW,light4.vLightData");

    const multiplied = await effectOf(...pairs[0]);
    setFixedShapeLightGuard(engine, "branch");
    frame(scene);
    for (const [material, mesh] of pairs) {
      const effect = await effectOf(material, mesh);
      expect(effect.defines).toContain("#define SLATE_FIXED_LIGHT_BRANCH");
      for (let seat = 0; seat < 6; seat++) expect(effect.fragmentSourceCode).toContain(`if (light${seat}.vLightDiffuse.a>=0.0) {`);
      expect(effect.fragmentSourceCode).not.toContain("step(0.0,light0.vLightDiffuse.a)");
    }
    expect(await effectOf(...pairs[0])).not.toBe(multiplied);
  });

  it("keeps Babylon's light defines for the CEL adapter and on Engines without uniform buffers", async () => {
    const { scene } = world();
    lightRig(scene);
    const cel = new CelMaterial(new PBRMaterial("source", scene), scene);
    const mesh = MeshBuilder.CreateBox("cel", {}, scene);
    mesh.material = cel;
    frame(scene);
    const effect = await effectOf(cel, mesh);
    expect(effect.defines).not.toContain("SLATE_FIXED_LIGHT");
    expect(effect.defines).toContain("#define LIGHT5\n");

    const engine = new NullEngine();
    engines.push(engine);
    const plain = new Scene(engine);
    plain.activeCamera = new UniversalCamera("camera", Vector3.Zero(), plain);
    setFixedShapeLightingWorldScene(plain);
    setFixedShapeLightingEnabled(engine, true);
    new PointLight("lamp", Vector3.Up(), plain);
    const standard = new StandardMaterial("standard", plain);
    const box = MeshBuilder.CreateBox("box", {}, plain);
    box.material = standard;
    frame(plain);
    expect((await effectOf(standard, box)).defines).not.toContain("SLATE_FIXED_LIGHT");
  });
});

describe("binding a previous Effect", () => {
  /** What `BindLights` binds for `effect` and the mesh's current lights, as a world view's draw of a previous Effect would. */
  function bindPrevious(material: Material & { maxSimultaneousLights: number }, mesh: Mesh, effect: Effect) {
    const blocks = vi.spyOn(effect, "bindUniformBuffer");
    const textures = vi.spyOn(effect, "setTexture");
    try {
      MaterialHelper.BindLights(mesh.getScene(), mesh, effect, mesh.subMeshes[0]!.materialDefines!, material.maxSimultaneousLights);
      return {
        blocks: new Map(blocks.mock.calls.map(([buffer, name]) => [name, buffer])),
        textures: new Map(textures.mock.calls.map(([name, texture]) => [name, texture])),
      };
    } finally {
      blocks.mockRestore();
      textures.mockRestore();
    }
  }
  const buffer = (light: Light) => (light as unknown as { _uniformBuffer: { getBuffer(): unknown } })._uniformBuffer.getBuffer();

  it("binds each shader light to a light of its own kind, or the empty buffer of that kind once none is left", async () => {
    const { engine, scene } = world({ fixed: false });
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.2), scene);
    const near = new PointLight("near", new Vector3(-1, 2, 1), scene);
    const far = new PointLight("far", new Vector3(1, 2, 1), scene);
    const { pbr, meshes } = receivers(scene);
    frame(scene);
    const previous = await effectOf(pbr, meshes[0]!);
    for (const [index, kind] of ["DIRLIGHT", "POINTLIGHT", "POINTLIGHT"].entries()) expect(previous.defines).toContain(`#define ${kind}${index}\n`);
    // One point goes and a spot arrives: the mesh's third light is now a spot, a larger Light block than the point's.
    setAuthoredLightEnabled(far, false);
    const spot = new SpotLight("spot", new Vector3(0, 3, 0), Vector3.Down(), 1, 2, scene);
    frame(scene);
    expect(meshes[0]!.lightSources).toEqual([sun, near, spot]);
    const { blocks } = bindPrevious(pbr, meshes[0]!, previous);
    expect([blocks.get("Light0"), blocks.get("Light1"), blocks.get("Light2")])
      .toEqual([buffer(sun), buffer(near), emptyLightSeatBuffer(engine, "point").getBuffer()]);
    // The Effect the mesh's lights ask for now binds as Babylon does.
    const current = await effectOf(pbr, meshes[0]!);
    expect(current).not.toBe(previous);
    expect(bindPrevious(pbr, meshes[0]!, current).blocks.get("Light2")).toBe(buffer(spot));
  });

  it("binds a placeholder of the sampler's type where the previous Effect samples a shadow map that is gone", async () => {
    const { scene } = world({ fixed: false });
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }) });
    const shadows = sceneShadowController(scene);
    const spot = new SpotLight("spot", new Vector3(0, 3, 0), Vector3.Down(), 1, 2, scene);
    shadows.register(spot, true);
    const { standard, meshes } = receivers(scene);
    meshes[1]!.receiveShadows = true;
    const sync = () => {
      syncSceneLighting(scene);
      shadows.sync();
      frame(scene);
    };
    sync();
    const previous = await effectOf(standard, meshes[1]!);
    expect(previous.defines).toContain("#define SHADOW0\n");
    // The spot stops casting: its map is released while the receiver may still draw the shadowed variant.
    shadows.register(spot, false);
    sync();
    expect(shadows.generator(spot)).toBeNull();
    preparePreviousEffectBindings(scene);
    const placeholders = existingShadowSamplerPlaceholders(scene)!;
    const bound = bindPrevious(standard, meshes[1]!, previous);
    expect(bound.blocks.get("Light0")).toBe(buffer(spot));
    expect(bound.textures.get("shadowTexture0")).toBe(previous.defines.includes("#define SHADOWPCF0\n") ? placeholders.compare : placeholders.plain);
  });
});

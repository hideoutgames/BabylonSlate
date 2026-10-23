import { describe, expect, it, vi } from "vitest";
import {
  Color3, DirectionalLight, FreeCamera, HemisphericLight, Matrix, MeshBuilder, NullEngine, PBRMaterial, PointLight, Scene, ShaderLanguage, Texture, TransformNode, Vector3,
  type Mesh, type UniformBuffer,
} from "@babylonjs/core";
import {
  RENDER_QUALITY_PROFILES, createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody, qualityPresetPatch, type QualityLevel,
} from "@haptic/core";
import { updateSceneRenderingSettings } from "./render-settings";
import { waterFftDiagnostics, waterFftForSurface } from "./water-fft";
import { WATER_FFT_CASCADE_TURNS } from "./water-fft-spectrum";
import {
  WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM, WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER, WATER_NODE_FOAM_UNIFORM, WATER_NODE_SUN_UNIFORM, WATER_VERTEX_WAVE_UNIFORMS,
  WaterMaterialPlugin, WaterVertexWaves, stripShaderComments, waterHazeConstants, waterOutlineVertexSource, waterShaderSource,
} from "./water-material";
import { createWaterMesh, setSceneWaterTime, setWaterGpuWaves, updateSceneWater } from "./water-mesh";
import { createWaterRemovalMesh } from "./water-removal-mesh";

/** Capture the shader upload boundary while using real scene objects and binding logic. */
function uniforms() {
  const vectors = new Map<string, number[]>(), matrices = new Map<string, Matrix>();
  const buffer = {
    updateFloat4: (name: string, ...values: number[]) => vectors.set(name, values),
    updateMatrix: (name: string, value: Matrix) => matrices.set(name, value.clone()),
  } as unknown as UniformBuffer;
  return { buffer, vectors, matrices };
}

function water(scene: Scene, x = 0, definition = createDefaultWaterDefinition()) {
  const material = new PBRMaterial("water", scene);
  const plugin = new WaterMaterialPlugin(material, definition, normalizeWaterBody({}));
  plugin.mesh = MeshBuilder.CreateGround("surface", { width: 2, height: 2 }, scene);
  plugin.mesh.position.x = x;
  plugin.mesh.computeWorldMatrix(true);
  return { material, plugin };
}

describe("Water material binding", () => {
  it("shares the scene light scan while retaining each material's environment strength and next-frame light changes", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const hemi = new HemisphericLight("ambient", Vector3.Up(), scene);
      hemi.diffuse.set(0.2, 0.4, 0.6); hemi.groundColor.set(0.1, 0.2, 0.3); hemi.intensity = 2;
      const sun = new DirectionalLight("sun", new Vector3(0, -2, 0), scene);
      sun.diffuse.set(1, 0.5, 0.25); sun.intensity = 3;
      const enabled = vi.spyOn(hemi, "isEnabled");
      const a = water(scene), b = water(scene), output = uniforms();
      a.plugin.water.reflectionStrength = 0;
      b.plugin.water.reflectionStrength = 0.5;
      b.material.reflectionTexture = new Texture(null, scene);
      const ambient = (plugin: WaterMaterialPlugin, expected: number[]) => {
        plugin.hardBindForSubMesh(output.buffer, scene);
        output.vectors.get("slateWaterLight")!.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 6));
      };
      scene.customRenderFunction = () => {
        enabled.mockClear();
        ambient(a.plugin, [1.93, 1.385, 1.2525, 0]);
        ambient(b.plugin, [2.11, 1.5875, 1.4775, 0]);
        ambient(a.plugin, [1.93, 1.385, 1.2525, 0]);
        expect(output.vectors.get("slateWaterSun")).toEqual([expect.closeTo(0), 1, expect.closeTo(0), 3]);
        expect(enabled).toHaveBeenCalledTimes(1);
      };
      scene.render();
      hemi.setEnabled(false); sun.intensity = 0;
      scene.customRenderFunction = () => {
        ambient(a.plugin, [0.08, 0.08, 0.08, 0]);
        ambient(b.plugin, [0.18, 0.2025, 0.225, 0]);
        expect(output.vectors.get("slateWaterSun")).toEqual([-0.4, 0.8, 0.45, 0]);
        scene.environmentTexture = b.material.reflectionTexture;
        a.plugin.water.reflectionStrength = 1;
        ambient(a.plugin, [0.36, 0.405, 0.45, 0]);
      };
      scene.render();
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("reflects a sky built from the scene's background, fog and sky light, hazes by the active camera's far plane, and absorbs the colours Shallow Color lacks first", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const { plugin } = water(scene), output = uniforms();
      const bound = (name: string) => { plugin.hardBindForSubMesh(output.buffer, scene); return output.vectors.get(name)!.slice(0, 3); };
      const linear = (value: number) => value ** 2.2;
      let sky: number[] = [], horizon: number[] = [], haze: number[] = [];
      scene.clearColor.set(0.5, 0.6, 0.8, 1);
      scene.customRenderFunction = () => { sky = bound("slateWaterSky"); horizon = bound("slateWaterHorizon"); haze = [...output.vectors.get("slateWaterHaze")!]; };
      scene.render();
      // Without fog the horizon is the background the scene shows as its sky; overhead it is deeper.
      horizon.forEach((value, i) => expect(value).toBeCloseTo(linear([0.5, 0.6, 0.8][i]!), 5));
      expect(sky[2]! / sky[0]!).toBeGreaterThan(horizon[2]! / horizon[0]!);
      const clearSky = sky;
      // A hemispheric light is the scene's sky light: it tints the zenith, and the next frame follows it.
      const hemi = new HemisphericLight("sky", Vector3.Up(), scene);
      hemi.diffuse.set(1, 0.4, 0.2); hemi.intensity = 1;
      scene.render();
      expect(sky[0]! / sky[2]!).toBeGreaterThan(clearSky[0]! / clearSky[2]!);
      // With fog the horizon is the fog the water itself fades into: Babylon's PBR fog colour, converted to linear space.
      scene.fogMode = Scene.FOGMODE_LINEAR; scene.fogColor.set(0.3, 0.35, 0.4);
      scene.render();
      const fog = scene.fogColor.toLinearSpace(engine.useExactSrgbConversions);
      expect(horizon).toEqual([expect.closeTo(fog.r, 5), expect.closeTo(fog.g, 5), expect.closeTo(fog.b, 5)]);
      // Aerial perspective follows the active camera's far plane: half the light is the air's at 0.4 of its range, the ramp
      // that makes the sea fully hazed ends before the far clip, a longer plane hazes over proportionally longer
      // distances, and a very long one is capped at atmospheric distances (8000 m) rather than hazing nothing.
      const camera = new FreeCamera("view", new Vector3(0, 2, 0), scene);
      scene.activeCamera = camera;
      const hazeFor = (far: number) => { camera.maxZ = far; scene.render(); return haze; };
      const near = hazeFor(2000), far = hazeFor(4000);
      expect(1 - Math.exp(-near[0]! * 0.4 * 2000)).toBeCloseTo(0.5, 6);
      expect(near[1]!).toBeLessThan(near[2]!); expect(near[2]!).toBeLessThan(2000);
      expect(far[0]!).toBeCloseTo(near[0]! / 2, 12); expect(far[2]!).toBeCloseTo(near[2]! * 2, 6);
      expect(hazeFor(1e6)).toEqual(hazeFor(8000));
      expect(Array.from(waterHazeConstants(1e6))).toEqual(hazeFor(8000));
      expect(hazeFor(1e6)[2]!).toBeLessThan(8000);
      // The asset's colours convert as the fog does, through the exact sRGB curve where the engine uses it.
      Object.defineProperty(engine, "useExactSrgbConversions", { value: true });
      (plugin.water as { deepColor: number[] }).deepColor = [0.03, 0.4, 0.8];
      const deep = new Color3(0.03, 0.4, 0.8).toLinearSpace(true);
      expect(bound("slateWaterDeep")).toEqual([expect.closeTo(deep.r, 6), expect.closeTo(deep.g, 6), expect.closeTo(deep.b, 6)]);
      // Absorption: water whose shallows look blue loses red first and blue last; grey shallows absorb every channel alike.
      const absorb = (shallowColor: [number, number, number]) => { (plugin.water as { shallowColor: number[] }).shallowColor = shallowColor; return bound("slateWaterAbsorb"); };
      const [r, g, b] = absorb([0.1, 0.4, 0.8]);
      expect(r).toBeGreaterThan(g!); expect(g).toBeGreaterThan(b!);
      const grey = absorb([0.2, 0.2, 0.2]);
      expect(grey[0]).toBeCloseTo(grey[1]!, 6); expect(grey[1]).toBeCloseTo(grey[2]!, 6);
      // Turquoise shallows (the Realistic default) pass blue at least as well as green, as water does (blue absorbing
      // faster turned them mint), and the colour they keep travels Depth Color Distance (its coefficient is 1).
      const turquoise = absorb(createDefaultWaterDefinition().shallowColor);
      expect(turquoise[2]).toBeLessThanOrEqual(turquoise[1]!);
      expect(turquoise[0]).toBeGreaterThan(turquoise[1]!);
      expect(Math.min(...turquoise)).toBeCloseTo(1, 6);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("lets sunlight through thin crests for a sun some way up, but not for a setting sun", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const { plugin } = water(scene), output = uniforms();
      const sun = new DirectionalLight("sun", Vector3.Down(), scene);
      let through: number[] = [];
      scene.customRenderFunction = () => { plugin.hardBindForSubMesh(output.buffer, scene); through = output.vectors.get("slateWaterThrough")!.slice(0, 3); };
      const elevation = (degrees: number) => { const a = degrees * Math.PI / 180; sun.direction.set(0, -Math.sin(a), -Math.cos(a)); scene.render(); return Math.max(...through); };
      expect(elevation(25)).toBeGreaterThan(0.05);
      // At sunset the light reaching the crests is dim, red and absorbed: no glow (it turned wave faces green).
      expect(elevation(3)).toBe(0);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("selects nearby cutters per surface, reuses repeated binds, and refreshes movement and membership on later passes", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const a = water(scene), b = water(scene, 100), output = uniforms();
      const cutters = [0, 1, 2, 3, 4, 100, 101].map((x) => {
        const mesh = createWaterRemovalMesh(scene, `cut-${x}`, { shape: "box", width: 8, height: 8, length: 8 }, { editor: false });
        mesh.position.x = x;
        return mesh;
      });
      const enabled = vi.spyOn(cutters[0]!, "isEnabled");
      const selected = (plugin: WaterMaterialPlugin) => {
        plugin.hardBindForSubMesh(output.buffer, scene);
        return [0, 1, 2, 3].map((i) => output.vectors.get(`slateWaterRemovalShape${i}`)![0] === 0
          ? null : -output.matrices.get(`slateWaterRemoval${i}`)!.getTranslation().x || 0);
      };
      scene.customRenderFunction = () => {
        enabled.mockClear();
        expect(selected(a.plugin)).toEqual([0, 1, 2, 3]);
        expect(selected(b.plugin)).toEqual([100, 101, null, null]);
        expect(selected(a.plugin)).toEqual([0, 1, 2, 3]);
        expect(enabled).toHaveBeenCalledTimes(1);
        // A later camera/render-target pass must not inherit stale scene data.
        cutters[0]!.position.x = 102;
        cutters[1]!.setEnabled(false);
        cutters[2]!.dispose();
        cutters[3]!.metadata.slateWaterRemoval.enabled = false;
        scene.incrementRenderId();
        expect(selected(a.plugin)).toEqual([4, null, null, null]);
        expect(selected(b.plugin)).toEqual([100, 101, 102, null]);
      };
      scene.render();
      const added = createWaterRemovalMesh(scene, "added", { shape: "sphere", width: 2, height: 2, length: 2 }, { editor: false });
      added.position.x = -1;
      scene.customRenderFunction = () => {
        expect(selected(a.plugin)).toEqual([4, -1, null, null]);
        a.plugin.mesh!.position.x = 100;
        a.plugin.mesh!.computeWorldMatrix(true);
        scene.incrementRenderId();
        expect(selected(a.plugin)).toEqual([100, 101, 102, null]);
      };
      scene.render();
      const parent = new TransformNode("boat", scene);
      added.parent = parent;
      parent.position.x = 101;
      parent.scaling.setAll(2);
      added.metadata.slateWaterRemoval.shape = "box";
      added.metadata.slateWaterRemoval.width = 20;
      scene.customRenderFunction = () => {
        a.plugin.hardBindForSubMesh(output.buffer, scene);
        expect(output.vectors.get("slateWaterRemovalShape0")).toEqual([1, 10, 1, 1]);
        const local = Vector3.TransformCoordinates(new Vector3(99, 0, 0), output.matrices.get("slateWaterRemoval0")!);
        expect(local.length()).toBeCloseTo(0);
      };
      scene.render();
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("compiles lit, reflective water that displaces on the GPU, one program for every sea", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
      new PointLight("lamp", new Vector3(0, 3, 0), scene);
      // Preview, editor scenes and Play all build water through createWaterMesh.
      const compiled = async (waveHeight = 0.45) => {
        const mesh = createWaterMesh(scene, "water", normalizeWaterBody({ resolution: 8 }), { ...createDefaultWaterDefinition(), waveHeight });
        const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
        await material.forceCompilationAsync(mesh);
        expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
        const defines = subMesh.effect!.defines;
        mesh.dispose();
        return defines;
      };
      const realistic = await compiled();
      expect(realistic).not.toContain("#define UNLIT");
      expect(realistic).toContain("#define LIGHT1");
      // Built-in water displaces its static rest grid in the vertex shader.
      expect(realistic).toContain("#define SLATE_WATER_GPU_WAVES");
      // Waves are uniforms and textures: another sea compiles the same program.
      expect(await compiled(2)).toBe(realistic);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("injects the water shading with no comments in any language or stage", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
      const main = stripShaderComments(waterShaderSource(ShaderLanguage.GLSL).main);
      const compiled = async (mesh: ReturnType<typeof createWaterMesh>) => {
        const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
        await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
        return subMesh.effect!;
      };
      const realistic = await compiled(createWaterMesh(scene, "realistic", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition()));
      expect(realistic.fragmentSourceCodeBeforeMigration).toContain(main);
      // Everything the plugin and the outline mask inject is free of comments and blank lines.
      const plugin = new WaterMaterialPlugin(new PBRMaterial("probe", scene), createDefaultWaterDefinition(), normalizeWaterBody({}));
      const pieces = [ShaderLanguage.GLSL, ShaderLanguage.WGSL].flatMap((language) => [
        ...Object.values(plugin.getCustomCode("fragment", language)!), ...Object.values(plugin.getCustomCode("vertex", language)!),
        ...Object.values(waterOutlineVertexSource(language)),
      ]);
      expect(pieces.length).toBeGreaterThan(0);
      for (const piece of pieces) expect(piece).not.toMatch(/\/\/|\n[ \t]*\n/);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("compiles the project's Water Shading Detail and draws Realistic Low unlit", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
      new PointLight("lamp", new Vector3(0, 3, 0), scene);
      const tier = (level: QualityLevel) => updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
      const compiled = async () => {
        const mesh = createWaterMesh(scene, "water", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition());
        const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
        await material.forceCompilationAsync(mesh);
        expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
        const defines = subMesh.effect!.defines;
        mesh.dispose();
        return defines;
      };
      const levels: QualityLevel[] = ["low", "medium", "high", "ultra"];
      for (const [index, level] of levels.entries()) {
        tier(level);
        const realistic = await compiled();
        expect(realistic).toContain(`#define SLATE_WATER_QUALITY ${index}`);
        // Low drops the PBR light loop (its shader lights foam and the sun itself); other tiers keep scene lights.
        if (level === "low") expect(realistic).not.toContain("#define LIGHT0");
        else expect(realistic).toContain("#define LIGHT1");
      }
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("recompiles live water, including a frozen Play material, when only the project Water Shading Detail changes", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
      // Medium everywhere except Shading Detail, so the grid (and its sub-meshes) stays the same.
      const detail = (shadingDetail: QualityLevel) => {
        const quality = normalizeRenderingQuality(qualityPresetPatch("medium"));
        updateSceneRenderingSettings(scene, { quality: { ...quality, water: { ...quality.water, shadingDetail, preset: "custom" } } });
      };
      detail("medium");
      const mesh = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition());
      const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
      const ready = async () => {
        await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
        return subMesh.effect!.defines;
      };
      expect(await ready()).toContain("#define SLATE_WATER_QUALITY 1");
      // Play freezes materials after their first ready: readiness then returns early without preparing defines, so
      // the per-frame water update must carry the new tier (and Low's unlit flag) into the frozen material.
      material.freeze();
      expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
      detail("low");
      updateSceneWater(scene);
      expect(mesh.subMeshes[0]).toBe(subMesh);
      const low = await ready();
      expect(low).toContain("#define SLATE_WATER_QUALITY 0");
      expect(low).not.toContain("#define LIGHT0");
      detail("ultra");
      updateSceneWater(scene);
      const ultra = await ready();
      expect(ultra).toContain("#define SLATE_WATER_QUALITY 3");
      expect(ultra).toContain("#define LIGHT0");
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("compiles the planar reflection only for flat bodies with Object Reflections at Planar, and no scene-copy feature outside a copy's pass", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
      const level = (preset: QualityLevel) => updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(preset)) });
      level("ultra");
      const compiled = async (mesh: ReturnType<typeof createWaterMesh>) => {
        const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
        await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
        return subMesh.effect!.defines;
      };
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition());
      const ultra = await compiled(lake);
      expect(ultra).toContain("#define SLATE_WATER_PLANAR\n");
      // This pass has no scene copy (captures draw like it): Ultra still compiles no
      // refraction or march into it.
      expect(ultra).not.toContain("SLATE_WATER_REFRACTION\n");
      expect(ultra).not.toContain("SLATE_WATER_SSR\n");
      // Play freezes materials: tilting the volume out of level, or leaving Planar, still recompiles without it.
      (lake.material as PBRMaterial).freeze();
      lake.rotation.z = 0.2;
      updateSceneWater(scene);
      expect(await compiled(lake)).not.toContain("SLATE_WATER_PLANAR\n");
      lake.rotation.z = 0;
      updateSceneWater(scene);
      expect(await compiled(lake)).toContain("SLATE_WATER_PLANAR\n");
      level("high");
      updateSceneWater(scene);
      expect(await compiled(lake)).not.toContain("SLATE_WATER_PLANAR\n");
      lake.dispose();
      // Without Object Reflections nothing is reflected, whatever the quality.
      level("ultra");
      const mirrorless = createWaterMesh(scene, "mirrorless", normalizeWaterBody({ resolution: 8 }), { ...createDefaultWaterDefinition(), objectReflections: false });
      expect(await compiled(mirrorless)).not.toContain("SLATE_WATER_PLANAR\n");
      mirrorless.dispose();
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("compiles the spectrum's cascades at every quality in both stages, and draws water flat where the device cannot run it", async () => {
    const host = (floats = true) => {
      const engine = new NullEngine();
      Object.assign(engine.getCaps(), { textureFloatRender: floats, textureHalfFloatRender: true });
      const scene = new Scene(engine);
      new FreeCamera("camera", new Vector3(0, 6, -12), scene).setTarget(Vector3.Zero());
      return { engine, scene };
    };
    const compiled = async (scene: Scene, level: QualityLevel) => {
      updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
      const mesh = createWaterMesh(scene, `lake-${level}`, normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition());
      const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
      await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
      // Draws are what ask for the spectrum (a 256² × 3 spectrum takes dozens of budgeted steps).
      for (let frame = 0; frame < 24; frame++) scene.render();
      const plugin = material.pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!;
      const result = { defines: subMesh.effect!.defines, outline: plugin.vertexWaveDefines().join("\n") };
      mesh.dispose();
      return result;
    };
    const capable = host(), weak = host(false);
    try {
      for (const level of ["low", "medium", "ultra"] as const) {
        const { defines, outline } = await compiled(capable.scene, level), cascades = RENDER_QUALITY_PROFILES[level].water.fftCascades;
        expect(defines).toContain(`#define SLATE_WATER_FFT ${cascades}\n`);
        // The outline mask's vertex pass displaces as the material's vertex stage does.
        expect(outline).toContain(`#define SLATE_WATER_FFT ${cascades}`);
      }
      expect(waterFftDiagnostics(capable.scene).created).toBeGreaterThan(0);
      // A device without float targets compiles the same program but never draws a spectrum or leases a simulation.
      expect((await compiled(weak.scene, "ultra")).defines).toContain(`#define SLATE_WATER_FFT ${RENDER_QUALITY_PROFILES.ultra.water.fftCascades}\n`);
      expect(waterFftDiagnostics(weak.scene)).toMatchObject({ simulations: [], created: 0, built: 0 });
    } finally {
      for (const { scene, engine } of [capable, weak]) { scene.dispose(); engine.dispose(); }
    }
  });

  it("asks for the spectrum from its own draws and binds it world-anchored, flat until it is ready", async () => {
    const engine = new NullEngine();
    Object.assign(engine.getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
    const scene = new Scene(engine);
    const fft = new Map<string, number[]>(), textures: Array<string | null> = [];
    try {
      new FreeCamera("camera", new Vector3(0, 6, -12), scene).setTarget(Vector3.Zero());
      updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("high")) });
      setSceneWaterTime(scene, 3);
      const body = normalizeWaterBody({ width: 40, length: 40, waveScale: 0.6, resolution: 8 }, "ocean");
      const mesh = createWaterMesh(scene, "sea", body, { ...createDefaultWaterDefinition(), steepness: 0.35 });
      const plugin = (mesh.material as PBRMaterial).pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!, subMesh = mesh.subMeshes[0]!;
      // The material's own uploads to its uniform buffer: its FFT uniforms and the texture bound to the band's sampler.
      const record = (buffer: UniformBuffer) => new Proxy(buffer, {
        get(target, key) {
          if (key === "updateFloat4") return (name: string, x: number, y: number, z: number, w: number) => {
            if (name.startsWith("slateWaterFft")) fft.set(name, [x, y, z, w]);
            target.updateFloat4(name, x, y, z, w);
          };
          if (key === "setTexture") return (name: string, texture: Parameters<UniformBuffer["setTexture"]>[1]) => {
            if (name === WATER_FFT_SAMPLER) textures.push((texture as { name?: string } | null)?.name ?? null);
            target.setTexture(name, texture);
          };
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const hardBind = plugin.hardBindForSubMesh.bind(plugin), bind = plugin.bindForSubMesh.bind(plugin);
      vi.spyOn(plugin, "hardBindForSubMesh").mockImplementation((buffer, ...rest) => hardBind(record(buffer), ...rest));
      vi.spyOn(plugin, "bindForSubMesh").mockImplementation((buffer, ...rest) => bind(record(buffer), ...rest));
      await vi.waitFor(() => { scene.render(); expect(fft.has("slateWaterFft")).toBe(true); });
      // Before the spectrum is ready: Wave Scale 0 and a placeholder, which leave the surface flat.
      expect(fft.get("slateWaterFft")![0]).toBe(0);
      expect(textures.at(-1)).toBe("water-fft-placeholder");
      // Nothing but the water's draws asks for the spectrum; it becomes ready within a few frames.
      await vi.waitFor(() => { scene.render(); expect(waterFftDiagnostics(scene).simulations.some((simulation) => simulation.ready)).toBe(true); }, { timeout: 10_000 });
      scene.render();
      // Wave Scale, and λ = 2 × Steepness.
      expect(fft.get("slateWaterFft")![0]).toBeCloseTo(0.6, 6);
      expect(fft.get("slateWaterFft")![1]).toBeCloseTo(0.7, 6);
      expect(textures.at(-1)).toBe("Water FFT Ocean");
      // Under large-world rendering, eye-relative rest points sample the texel of their world position (texel (i, j)
      // holds (i, j) · L / N in the cascade's turned frame p = R(−θ)·(X, Z), sampled at its centre), whatever the
      // floating origin; the shader turns the eye-relative point by the same R(−θ).
      const band = waterFftForSurface(scene, plugin.water)!, size = RENDER_QUALITY_PROFILES.high.water.fftSize;
      const origin = new Vector3(81234.5, 3, -40321.25);
      vi.spyOn(scene, "floatingOriginMode", "get").mockReturnValue(true);
      vi.spyOn(scene, "floatingOriginOffset", "get").mockReturnValue(origin);
      const output = uniforms();
      plugin.hardBindForSubMesh(output.buffer, scene, engine, subMesh);
      const fract = (value: number) => value - Math.floor(value);
      const rest = { x: 3.25, z: -1.5 };
      for (let c = 0; c < band.cascades; c++) {
        const [scale, offsetU, offsetV] = output.vectors.get(`slateWaterFftCascade${c}`)!, patch = band.patchSizes[c]!;
        const cos = Math.cos(WATER_FFT_CASCADE_TURNS[c]!), sin = Math.sin(WATER_FFT_CASCADE_TURNS[c]!);
        const turned = (x: number, z: number) => ({ u: cos * x + sin * z, v: cos * z - sin * x });
        const local = turned(rest.x, rest.z), world = turned(origin.x + rest.x, origin.z + rest.z);
        expect(fract(local.u * scale! + offsetU! - (world.u / patch + 0.5 / size) + 0.5) - 0.5).toBeCloseTo(0, 4);
        expect(fract(local.v * scale! + offsetV! - (world.v / patch + 0.5 / size) + 0.5) - 0.5).toBeCloseTo(0, 4);
      }
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });

  it("binds Global Water's grid offset per surface for the material and the outline mask's vertex pass, and zero off the GPU path", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(40, 6, -25), scene);
      updateSceneRenderingSettings(scene, { water: { blendDistance: 0 } });
      const a = createWaterMesh(scene, "a", normalizeWaterBody({}, "global")), b = createWaterMesh(scene, "b", normalizeWaterBody({}, "global"));
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 20, length: 20 }));
      // A turned, scaled and displaced volume: its offset is the grid centre in its own space, bound in world space.
      b.position.set(100, 0, -30); b.rotation.y = Math.PI / 2; b.scaling.set(2, 1, 2);
      updateSceneWater(scene);
      const pluginOf = (mesh: Mesh) => (mesh.material as PBRMaterial).pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!;
      const bound = (plugin: WaterMaterialPlugin, mesh: Mesh) => {
        const output = uniforms();
        plugin.hardBindForSubMesh(output.buffer, scene, engine, mesh.subMeshes[0]!);
        return output.vectors.get("slateWaterGridOffset")!;
      };
      // The snapped centre is the camera within one cell, so each surface's world offset is the camera relative to it.
      const cell = 0.5 / RENDER_QUALITY_PROFILES.medium.water.meshDensity;
      const offsetA = bound(pluginOf(a), a), offsetB = bound(pluginOf(b), b);
      for (const [i, expected] of [40, 0, -25].entries()) expect(Math.abs(offsetA[i]! - expected)).toBeLessThanOrEqual(cell);
      for (const [i, expected] of [-60, 0, 5].entries()) expect(Math.abs(offsetB[i]! - expected)).toBeLessThanOrEqual(cell);
      // A surface sharing the material is still read for its own mesh: the draw's sub-mesh decides.
      expect(bound(pluginOf(a), b)).toEqual(offsetB);
      expect(bound(pluginOf(b), a)).toEqual(offsetA);
      // The outline mask's program takes the same value from the drawn mesh.
      const effect = new Map<string, number[]>();
      const pass = { setFloat4: (name: string, ...values: number[]) => effect.set(name, values), setTexture: () => {} } as unknown as Parameters<WaterMaterialPlugin["bindVertexWaves"]>[0];
      pluginOf(a).bindVertexWaves(pass, scene, b);
      expect(effect.get("slateWaterGridOffset")).toEqual(offsetB);
      // Finite water, and Global Water drawn from displaced CPU vertices, carry their rest points as they are.
      expect(bound(pluginOf(lake), lake)).toEqual([0, 0, 0, 0]);
      setWaterGpuWaves(a, false); updateSceneWater(scene);
      expect(bound(pluginOf(a), a)).toEqual([0, 0, 0, 0]);
      setWaterGpuWaves(a, true); updateSceneWater(scene);
      expect(bound(pluginOf(a), a)).toEqual(offsetA);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("binds a surface without a plugin the same displacement the plugin binds to another pass, plus its clock, eye, foam and sun", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(3, 4, -5), scene).computeWorldMatrix();
      const { plugin } = water(scene, 0, createDefaultWaterDefinition()), mesh = plugin.mesh!;
      const waves = new WaterVertexWaves(plugin.water, plugin.body);
      plugin.time = waves.time = 7.25;
      const record = () => {
        const vectors = new Map<string, number[]>(), textures = new Map<string, unknown>();
        return { vectors, textures, sink: { setFloat4: (name: string, ...values: number[]) => { vectors.set(name, values); }, setTexture: (name: string, texture: unknown) => { textures.set(name, texture); } } };
      };
      const pass = record(), own = record();
      plugin.bindVertexWaves(pass.sink as unknown as Parameters<WaterMaterialPlugin["bindVertexWaves"]>[0], scene, mesh);
      waves.bind(own.sink, scene, mesh);
      // Every vertex uniform the node's shader reads is bound, and bound to what the plugin binds, with the same texture.
      expect([...own.vectors.keys()].sort()).toEqual([...WATER_VERTEX_WAVE_UNIFORMS, WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM, WATER_NODE_FOAM_UNIFORM, WATER_NODE_SUN_UNIFORM].sort());
      for (const name of WATER_VERTEX_WAVE_UNIFORMS) expect(own.vectors.get(name), name).toEqual(pass.vectors.get(name));
      expect(own.textures.get(WATER_FFT_SAMPLER)).toBe(pass.textures.get(WATER_FFT_SAMPLER));
      expect(own.textures.has(WATER_FOAM_SAMPLER)).toBe(true);
      expect(own.vectors.get(WATER_CLOCK_UNIFORM)).toEqual([7.25, 0, 0, 0]);
      expect(own.vectors.get(WATER_EYE_UNIFORM)).toEqual([3, 4, -5, 0]);
      expect(own.vectors.get(WATER_NODE_FOAM_UNIFORM)).toEqual([plugin.water.crestFoam, plugin.water.foamAmount, 0, 0]);
      expect(own.vectors.get(WATER_NODE_SUN_UNIFORM)![3]).toBe(plugin.water.subsurface);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("keeps scene snapshots separate and preserves insertion order for equally near removals", () => {
    const engine = new NullEngine(), a = new Scene(engine), b = new Scene(engine);
    try {
      const first = water(a), second = water(b), output = uniforms();
      first.plugin.water.reflectionStrength = second.plugin.water.reflectionStrength = 0;
      const sun = new DirectionalLight("sun", new Vector3(0, -1, 0), b);
      sun.diffuse.set(0, 0, 1);
      for (const shape of ["box", "sphere", "cylinder", "capsule", "box"]) {
        createWaterRemovalMesh(a, shape, { shape, width: 2, height: 2, length: 2 }, { editor: false });
      }
      first.plugin.hardBindForSubMesh(output.buffer, a);
      expect([0, 1, 2, 3].map((i) => output.vectors.get(`slateWaterRemovalShape${i}`)![0])).toEqual([1, 2, 3, 4]);
      expect(output.vectors.get("slateWaterLight")).toEqual([0.08, 0.08, 0.08, 0]);
      second.plugin.hardBindForSubMesh(output.buffer, b);
      expect(output.vectors.get("slateWaterLight")).toEqual([0, 0, 0.55, 0]);
      expect([0, 1, 2, 3].map((i) => output.vectors.get(`slateWaterRemovalShape${i}`)![0])).toEqual([0, 0, 0, 0]);
    } finally { a.dispose(); b.dispose(); engine.dispose(); }
  });
});

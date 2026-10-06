import { describe, expect, it, vi } from "vitest";
import {
  DirectionalLight, FreeCamera, HemisphericLight, Matrix, MeshBuilder, NullEngine, PBRMaterial, PointLight, Scene, Texture, TransformNode, Vector3, type UniformBuffer,
} from "@babylonjs/core";
import {
  WATER_WAVE_MAX_COMPONENTS, createDefaultWaterDefinition, createWaterWaveOutput, evaluateWaterWaves, normalizeRenderingQuality, normalizeWaterBody,
  normalizeWaterDefinition, qualityPresetPatch, waterWaveSet, type QualityLevel, type WaterDefinition,
} from "@babylonslate/core";
import { updateSceneRenderingSettings } from "./render-settings";
import { waterFftDiagnostics, waterFftForSurface } from "./water-fft";
import { WATER_FFT_SAMPLER, WaterMaterialPlugin } from "./water-material";
import { createWaterMesh, setSceneWaterTime, updateSceneWater } from "./water-mesh";
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

function water(scene: Scene, x = 0) {
  const material = new PBRMaterial("water", scene);
  const plugin = new WaterMaterialPlugin(material, createDefaultWaterDefinition(), normalizeWaterBody({}));
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

  it("reflects a sky built from the scene's background, fog and sky light, and absorbs the colours Shallow Color lacks first", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const { plugin } = water(scene), output = uniforms();
      const bound = (name: string) => { plugin.hardBindForSubMesh(output.buffer, scene); return output.vectors.get(name)!.slice(0, 3); };
      const linear = (value: number) => value ** 2.2;
      let sky: number[] = [], horizon: number[] = [];
      scene.clearColor.set(0.5, 0.6, 0.8, 1);
      scene.customRenderFunction = () => { sky = bound("slateWaterSky"); horizon = bound("slateWaterHorizon"); };
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
      // Absorption: water whose shallows look blue loses red first and blue last; grey shallows absorb every channel alike.
      const absorb = (shallowColor: [number, number, number]) => { (plugin.water as { shallowColor: number[] }).shallowColor = shallowColor; return bound("slateWaterAbsorb"); };
      const [r, g, b] = absorb([0.1, 0.4, 0.8]);
      expect(r).toBeGreaterThan(g!); expect(g).toBeGreaterThan(b!);
      const grey = absorb([0.2, 0.2, 0.2]);
      expect(grey[0]).toBeCloseTo(grey[1]!, 6); expect(grey[1]).toBeCloseTo(grey[2]!, 6);
      // Turquoise shallows (the Realistic default) pass blue at least as well as green, as water does (blue absorbing
      // faster turned them mint), and the colour they keep travels Depth Color Distance (its coefficient is 1).
      const turquoise = absorb(createDefaultWaterDefinition("realistic").shallowColor);
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

  it("compiles only the asset's style: lit, reflective Realistic and unlit Stylized that ignores scene lights", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
      new PointLight("lamp", new Vector3(0, 3, 0), scene);
      // Preview, editor scenes and Play all build water through createWaterMesh; a Style edit rebuilds it everywhere.
      const compiled = async (style: "realistic" | "stylized", waveModel: "classic" | "ocean" = "classic") => {
        const mesh = createWaterMesh(scene, style, normalizeWaterBody({ resolution: 8 }), { ...createDefaultWaterDefinition(style), waveModel });
        const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
        await material.forceCompilationAsync(mesh);
        expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
        const defines = subMesh.effect!.defines;
        mesh.dispose();
        return defines;
      };
      const stylized = await compiled("stylized");
      expect(stylized).toContain("#define SLATE_WATER_STYLIZED");
      expect(stylized).toContain("#define UNLIT");
      expect(stylized).not.toContain("#define LIGHT0");
      const realistic = await compiled("realistic");
      expect(realistic).not.toContain("#define SLATE_WATER_STYLIZED");
      expect(realistic).not.toContain("#define UNLIT");
      expect(realistic).toContain("#define LIGHT1");
      // Built-in water displaces its static rest grid in the vertex shader.
      expect(realistic).toContain("#define SLATE_WATER_GPU_WAVES");
      // Classic compiles only its five swell components; Ocean Spectrum adds its other three.
      expect(realistic).not.toContain("#define SLATE_WATER_OCEAN");
      expect(await compiled("stylized", "ocean")).toContain("#define SLATE_WATER_OCEAN");
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("compiles the project's Water Shading Detail, draws Realistic Low unlit, and compiles out asset features set to zero", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
      new PointLight("lamp", new Vector3(0, 3, 0), scene);
      const tier = (level: QualityLevel) => updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
      const compiled = async (style: "realistic" | "stylized", overrides: Partial<WaterDefinition> = {}) => {
        const mesh = createWaterMesh(scene, style, normalizeWaterBody({ resolution: 8 }), { ...createDefaultWaterDefinition(style), ...overrides });
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
        const realistic = await compiled("realistic"), stylized = await compiled("stylized");
        expect(realistic).toContain(`#define SLATE_WATER_QUALITY ${index}`);
        expect(stylized).toContain(`#define SLATE_WATER_QUALITY ${index}`);
        // Low drops the PBR light loop (its shader lights foam and the sun itself); other tiers keep scene lights.
        if (level === "low") expect(realistic).not.toContain("#define LIGHT0");
        else expect(realistic).toContain("#define LIGHT1");
      }
      tier("high");
      // Realistic defaults: Crest Foam, Surface Foam and Subsurface on, Sparkles off.
      const defaults = await compiled("realistic");
      for (const define of ["SLATE_WATER_CREST_FOAM", "SLATE_WATER_SURFACE_FOAM", "SLATE_WATER_SSS"]) expect(defaults).toContain(`#define ${define}\n`);
      expect(defaults).not.toContain("SLATE_WATER_SPARKLES\n");
      const inverted = await compiled("realistic", { crestFoam: 0, surfaceFoam: 0, subsurface: 0, sparkles: 0.5 });
      for (const define of ["SLATE_WATER_CREST_FOAM", "SLATE_WATER_SURFACE_FOAM", "SLATE_WATER_SSS"]) expect(inverted).not.toContain(`#define ${define}\n`);
      expect(inverted).toContain("#define SLATE_WATER_SPARKLES\n");
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
      const mesh = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition("realistic"));
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
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition("realistic"));
      const ultra = await compiled(lake);
      expect(ultra).toContain("#define SLATE_WATER_PLANAR\n");
      // This pass has no scene copy (classic frames, captures and previews draw like it): Ultra still compiles no
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
      // Without Object Reflections (the Stylized default) nothing is reflected, whatever the quality.
      level("ultra");
      const stylized = createWaterMesh(scene, "stylized", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition("stylized"));
      expect(await compiled(stylized)).not.toContain("SLATE_WATER_PLANAR\n");
      stylized.dispose();
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("binds the shared swell relative to the floating origin and clock, so eye-relative rest points reproduce the kernel", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const definition = normalizeWaterDefinition({ ...createDefaultWaterDefinition(), waveModel: "ocean", waveSeed: 7, choppiness: 0, steepness: 0.8 });
      const body = normalizeWaterBody({ width: 40, length: 40, waveScale: 0.6 }, "ocean"), output = uniforms();
      const plugin = new WaterMaterialPlugin(new PBRMaterial("water", scene), definition, body);
      plugin.mesh = MeshBuilder.CreateGround("surface", { width: 2, height: 2 }, scene);
      plugin.time = 98765.4;
      // Large-world rendering: shaders see positions relative to the eye, which sits far from the world origin.
      const origin = new Vector3(81234.5, 3, -40321.25);
      vi.spyOn(scene, "floatingOriginMode", "get").mockReturnValue(true);
      vi.spyOn(scene, "floatingOriginOffset", "get").mockReturnValue(origin);
      plugin.hardBindForSubMesh(output.buffer, scene);
      const rest = { x: 3.25, z: -1.5 }, kernel = createWaterWaveOutput();
      evaluateWaterWaves(waterWaveSet(definition), origin.x + rest.x, origin.z + rest.z, plugin.time, 0, kernel, body.waveScale);
      let height = 0, offsetX = 0, offsetZ = 0;
      for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++) {
        const [dx, dz, k] = output.vectors.get(`slateWaterSwellDir${i}`)!, [amplitude, phase, gerstner] = output.vectors.get(`slateWaterSwellAmp${i}`)!;
        const p = k! * (dx! * rest.x + dz! * rest.z) + phase!;
        height += amplitude! * Math.sin(p); offsetX += gerstner! * dx! * Math.cos(p); offsetZ += gerstner! * dz! * Math.cos(p);
      }
      // Float32 uniforms keep the phases small, so the shader's swell matches the float64 kernel closely.
      expect(height).toBeCloseTo(kernel[0]!, 4);
      expect(offsetX).toBeCloseTo(kernel[1]!, 4);
      expect(offsetZ).toBeCloseTo(kernel[2]!, 4);
      // Finite bodies fade the offset at their banks; Gerstner foam switches on only with horizontal motion.
      const [fadeLength, gerstnerOn] = output.vectors.get("slateWaterSwellInfo")!;
      expect(fadeLength).toBeGreaterThan(0);
      expect(gerstnerOn).toBe(1);
      definition.steepness = 0;
      plugin.hardBindForSubMesh(output.buffer, scene);
      expect(output.vectors.get("slateWaterSwellInfo")!.slice(0, 2)).toEqual([0, 0]);
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });

  it("compiles the FFT detail band's preset cascades only where device-effective FFT Ocean Detail and Detail Waves run, and runs no band for other water", async () => {
    const host = (floats = true) => {
      const engine = new NullEngine();
      Object.assign(engine.getCaps(), { textureFloatRender: floats, textureHalfFloatRender: true });
      const scene = new Scene(engine);
      new FreeCamera("camera", new Vector3(0, 6, -12), scene).setTarget(Vector3.Zero());
      return { engine, scene };
    };
    const compiled = async (scene: Scene, level: QualityLevel, overrides: Partial<WaterDefinition> = {}) => {
      updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch(level)) });
      const mesh = createWaterMesh(scene, `lake-${level}`, normalizeWaterBody({ resolution: 8 }), { ...createDefaultWaterDefinition(), ...overrides });
      const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
      await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
      // Draws are what ask for the band: water whose shader does not sample it must leave the scene without one.
      for (let frame = 0; frame < 6; frame++) scene.render();
      const defines = subMesh.effect!.defines;
      mesh.dispose();
      return defines;
    };
    const capable = host(), weak = host(false);
    try {
      expect(await compiled(capable.scene, "high")).toContain("#define SLATE_WATER_FFT 2\n");
      expect(await compiled(capable.scene, "ultra")).toContain("#define SLATE_WATER_FFT 3\n");
      const before = waterFftDiagnostics(capable.scene);
      expect(before.created).toBeGreaterThan(0);
      const off = [
        await compiled(weak.scene, "ultra"),
        await compiled(capable.scene, "medium"),
        await compiled(capable.scene, "ultra", { detailWaves: 0 }),
        await compiled(capable.scene, "ultra", createDefaultWaterDefinition("stylized")),
      ];
      for (const defines of off) expect(defines).toContain("#define SLATE_WATER_FFT 0\n");
      // Neither a device without float targets, Medium, Detail Waves 0 nor the Stylized default drew a spectrum or
      // leased a simulation.
      expect(waterFftDiagnostics(weak.scene)).toMatchObject({ simulations: [], created: 0, built: 0 });
      const after = waterFftDiagnostics(capable.scene);
      expect([after.created, after.built]).toEqual([before.created, before.built]);
    } finally {
      for (const { scene, engine } of [capable, weak]) { scene.dispose(); engine.dispose(); }
    }
  });

  it("compiles the band's vertex part only into surfaces whose grid resolves its first cascade, and the outline mask follows", async () => {
    const engine = new NullEngine();
    Object.assign(engine.getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
    const scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 6, -12), scene).setTarget(Vector3.Zero());
      updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("high")) });
      const compiled = async (name: string, body: ReturnType<typeof normalizeWaterBody>) => {
        const mesh = createWaterMesh(scene, name, body, createDefaultWaterDefinition());
        const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
        await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
        const plugin = material.pluginManager!.getPlugin<WaterMaterialPlugin>("SlateWater")!;
        return { defines: subMesh.effect!.defines, outline: plugin.vertexWaveDefines().join("\n") };
      };
      // High's first cascade is short (Wave Length / 23, half of it 26 cm by default): a 30 m lake's cells (at least
      // half a metre) can never pass it, so only the fragment samples the band.
      const lake = await compiled("lake", normalizeWaterBody({ width: 30, length: 30 }));
      expect(lake.defines).toContain("#define SLATE_WATER_FFT 2\n");
      expect(lake.defines).toContain("#define SLATE_WATER_FFT_VERTEX 0\n");
      expect(lake.outline).not.toContain("SLATE_WATER_FFT");
      // A 1 m puddle's 8 cm cells resolve it: its vertex stage, and its outline mask, displace by the band.
      const puddle = await compiled("puddle", normalizeWaterBody({ width: 1, length: 1 }, "puddle"));
      expect(puddle.defines).toContain("#define SLATE_WATER_FFT 2\n");
      expect(puddle.defines).toContain("#define SLATE_WATER_FFT_VERTEX 2\n");
      expect(puddle.outline).toContain("#define SLATE_WATER_FFT_VERTEX 2");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("asks for the FFT detail band from its own draws and binds it world-anchored, contributing nothing until it is ready", async () => {
    const engine = new NullEngine();
    Object.assign(engine.getCaps(), { textureFloatRender: true, textureHalfFloatRender: true });
    const scene = new Scene(engine);
    const fft = new Map<string, number[]>(), textures: Array<string | null> = [];
    try {
      new FreeCamera("camera", new Vector3(0, 6, -12), scene).setTarget(Vector3.Zero());
      updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality(qualityPresetPatch("high")) });
      setSceneWaterTime(scene, 3);
      const body = normalizeWaterBody({ width: 40, length: 40, waveScale: 0.6, resolution: 8 }, "ocean");
      const mesh = createWaterMesh(scene, "sea", body, { ...createDefaultWaterDefinition(), steepness: 0.7 });
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
      // Before the band is ready: gain 0 and a placeholder, which leave the analytic surface exactly as it is, and every
      // cascade faded even at a micrometre footprint or mesh spacing, so neither stage pays for a single tap.
      expect(fft.get("slateWaterFft")!.slice(0, 2)).toEqual([0, 0]);
      expect(textures.at(-1)).toBe("water-fft-placeholder");
      for (const c of [0, 1]) expect(fft.get(`slateWaterFftCascade${c}`)![3]! * 1e-6, `cascade ${c}`).toBeGreaterThan(2.2);
      // Nothing but the water's draws asks for the band; it becomes ready within a few frames.
      await vi.waitFor(() => { scene.render(); expect(waterFftDiagnostics(scene).simulations.some((simulation) => simulation.ready)).toBe(true); });
      scene.render();
      expect(fft.get("slateWaterFft")![0]).toBeCloseTo(0.6, 6);
      expect(fft.get("slateWaterFft")![1]).toBeCloseTo(0.7, 6);
      expect(textures.at(-1)).toBe("Water FFT Detail");
      // Under large-world rendering, eye-relative rest points sample the texel of their world position (texel (i, j)
      // holds world (i, j) · L / N, sampled at its centre), whatever the floating origin.
      const band = waterFftForSurface(scene, plugin.water)!, size = 128;
      const origin = new Vector3(81234.5, 3, -40321.25);
      vi.spyOn(scene, "floatingOriginMode", "get").mockReturnValue(true);
      vi.spyOn(scene, "floatingOriginOffset", "get").mockReturnValue(origin);
      const output = uniforms();
      plugin.hardBindForSubMesh(output.buffer, scene, engine, subMesh);
      const fract = (value: number) => value - Math.floor(value);
      const rest = { x: 3.25, z: -1.5 };
      for (let c = 0; c < band.cascades; c++) {
        const [scale, offsetU, offsetV] = output.vectors.get(`slateWaterFftCascade${c}`)!, patch = band.patchSizes[c]!;
        expect(fract(rest.x * scale! + offsetU! - ((origin.x + rest.x) / patch + 0.5 / size) + 0.5) - 0.5).toBeCloseTo(0, 4);
        expect(fract(rest.z * scale! + offsetV! - ((origin.z + rest.z) / patch + 0.5 / size) + 0.5) - 0.5).toBeCloseTo(0, 4);
      }
      // The last cascade fades by its Nyquist wavenumber, π · N / L.
      const last = band.cascades - 1;
      expect(output.vectors.get(`slateWaterFftCascade${last}`)![3]).toBeCloseTo(Math.PI * size / band.patchSizes[last]!, 3);
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
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

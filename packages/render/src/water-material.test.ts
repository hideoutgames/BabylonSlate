import { describe, expect, it, vi } from "vitest";
import {
  DirectionalLight, FreeCamera, HemisphericLight, Matrix, MeshBuilder, NullEngine, PBRMaterial, PointLight, Scene, Texture, TransformNode, Vector3,
  type Mesh, type UniformBuffer,
} from "@babylonjs/core";
import {
  WATER_WAVE_MAX_COMPONENTS, RENDER_QUALITY_PROFILES, createDefaultWaterDefinition, createWaterWaveOutput, evaluateWaterWaves, normalizeRenderingQuality, normalizeWaterBody,
  normalizeWaterDefinition, qualityPresetPatch, waterWaveSet, waterWaveSurge, type QualityLevel, type WaterDefinition,
} from "@babylonslate/core";
import { updateSceneRenderingSettings } from "./render-settings";
import { waterFftDiagnostics, waterFftForSurface } from "./water-fft";
import { WATER_FFT_CASCADE_TURNS } from "./water-fft-spectrum";
import { WATER_FFT_SAMPLER, WaterMaterialPlugin, waterHazeConstants } from "./water-material";
import { createWaterMesh, setSceneWaterTime, setWaterGpuWaves, updateSceneWater, updateWaterMeshDefinition } from "./water-mesh";
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
      // Both wave models evaluate eight components: Wave Model is uniform-only and compiles the same program.
      expect(await compiled("realistic", "ocean")).toBe(realistic);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("compiles the Toon look only for Stylized water and switches the look in place without a rebuild", async () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      new FreeCamera("camera", new Vector3(0, 5, -10), scene);
      new DirectionalLight("sun", new Vector3(0, -1, 0.3), scene);
      const defines = async (mesh: ReturnType<typeof createWaterMesh>) => {
        const material = mesh.material as PBRMaterial, subMesh = mesh.subMeshes[0]!;
        await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true));
        return subMesh.effect!.defines;
      };
      const painted = createWaterMesh(scene, "stylized", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition("stylized"));
      const material = painted.material;
      expect(await defines(painted)).toContain("#define SLATE_WATER_STYLIZED");
      expect(await defines(painted)).not.toContain("SLATE_WATER_TOON\n");
      // A Details edit of Stylized Look keeps the surface and its material and recompiles it as Toon.
      expect(updateWaterMeshDefinition(painted, createDefaultWaterDefinition("stylized", "toon"))).toBe(true);
      expect(painted.material).toBe(material);
      expect(await defines(painted)).toContain("#define SLATE_WATER_TOON\n");
      // Realistic water ignores a stored look.
      const realistic = createWaterMesh(scene, "realistic", normalizeWaterBody({ resolution: 8 }), { ...createDefaultWaterDefinition(), stylizedLook: "toon" });
      expect(await defines(realistic)).not.toContain("SLATE_WATER_TOON\n");
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
      // The shader evaluates every component at the warped rest point rest + W(rest), from the warp's own uniforms.
      const warped = { ...rest };
      for (let t = 0; t < 3; t++) {
        const [kx, kz, scaled, phase] = output.vectors.get(`slateWaterSwellWarp${t}`)!, cos = Math.cos(kx! * rest.x + kz! * rest.z + phase!);
        warped.x += kx! * scaled! * cos; warped.z += kz! * scaled! * cos;
      }
      let height = 0, offsetX = 0, offsetZ = 0;
      for (let i = 0; i < WATER_WAVE_MAX_COMPONENTS; i++) {
        const [dx, dz, k] = output.vectors.get(`slateWaterSwellDir${i}`)!, [amplitude, phase, gerstner] = output.vectors.get(`slateWaterSwellAmp${i}`)!;
        // The height rides the component's wave group, (1 + m·cos(κê·u + ψ)) / √(1 + m²/2); the offset carries none.
        const [gx, gz, groupPhase, depth] = output.vectors.get(`slateWaterSwellGroup${i}`)!;
        const group = (1 + depth! * Math.cos(gx! * warped.x + gz! * warped.z + groupPhase!)) / Math.sqrt(1 + 0.5 * depth! * depth!);
        const p = k! * (dx! * warped.x + dz! * warped.z) + phase!;
        height += amplitude! * group * Math.sin(p); offsetX += gerstner! * dx! * Math.cos(p); offsetZ += gerstner! * dz! * Math.cos(p);
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

  it("counts the steepest swell slot's wrapped periods, so Toon's crest indices never jump as its phase uniform wraps", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const definition = createDefaultWaterDefinition("stylized", "toon");
      const plugin = new WaterMaterialPlugin(new PBRMaterial("water", scene), definition, normalizeWaterBody({}, "global")), output = uniforms();
      plugin.mesh = MeshBuilder.CreateGround("surface", { width: 2, height: 2 }, scene);
      vi.spyOn(scene, "floatingOriginMode", "get").mockReturnValue(true);
      vi.spyOn(scene, "floatingOriginOffset", "get").mockReturnValue(new Vector3(81234.5, 0, -40321.25));
      // The crest index the shader adds to a local floor(phase / 2π): the reduced phase plus the counted periods.
      const unwrapped = (time: number) => {
        plugin.time = time;
        plugin.hardBindForSubMesh(output.buffer, scene);
        const phase = output.vectors.get("slateWaterSwellAmp0")![1]!, count = output.vectors.get("slateWaterLight")![3]!;
        expect(Number.isInteger(count)).toBe(true);
        return { phase, value: phase + 2 * Math.PI * count, omega: output.vectors.get("slateWaterSwellDir0")![3]! };
      };
      let previous = unwrapped(98765.4), wraps = 0;
      const step = 0.05, span = 4096 * 2 * Math.PI, set = waterWaveSet(definition);
      // The slot's phase also carries its component's surge (`waterWaveSurge`).
      const lead = Array.from(set.omega).findIndex((omega) => Math.abs(omega - previous.omega) < 1e-4);
      const surge = (time: number) => waterWaveSurge(set, time)[lead]!;
      for (let i = 1; i <= 120; i++) {
        const time = 98765.4 + i * step, next = unwrapped(time);
        if (next.phase > previous.phase) wraps++;
        // Continuous through every wrap of the uniform (the count itself repeats only every 4096 crests).
        const change = ((next.value - previous.value) % span + span * 1.5) % span - span / 2;
        expect(change).toBeCloseTo(-next.omega * step + surge(time) - surge(time - step), 3);
        previous = next;
      }
      // Six seconds cross several of the slot's periods: the uniform phase wrapped each time, and the count carried it.
      expect(wraps).toBeGreaterThanOrEqual(2);
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });

  it("runs the shore swash on the steepest slot's clock with a cycle count, so each wave keeps its reach as the clock wraps", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const definition = createDefaultWaterDefinition("stylized", "toon");
      const plugin = new WaterMaterialPlugin(new PBRMaterial("water", scene), definition, normalizeWaterBody({}, "global")), output = uniforms();
      plugin.mesh = MeshBuilder.CreateGround("surface", { width: 2, height: 2 }, scene);
      vi.spyOn(scene, "floatingOriginMode", "get").mockReturnValue(true);
      vi.spyOn(scene, "floatingOriginOffset", "get").mockReturnValue(new Vector3(81234.5, 0, -40321.25));
      const bind = (time: number) => {
        plugin.time = time;
        plugin.hardBindForSubMesh(output.buffer, scene);
        const [phase, count, kappa, excursion] = output.vectors.get("slateWaterSwash")!;
        const [dx, dz, k, omega] = output.vectors.get("slateWaterSwellDir0")!;
        return { phase: phase!, count: count!, kappa: kappa!, excursion: excursion!, dx: dx!, dz: dz!, k: k!, omega: omega! };
      };
      const TAU = 2 * Math.PI, span = 4096 * TAU, start = 98765.4, step = 0.05, set = waterWaveSet(definition);
      let previous = bind(start), wraps = 0;
      // The swash follows the slot's surge (`waterWaveSurge`) at its own half rate.
      const lead = Array.from(set.omega).findIndex((omega) => Math.abs(omega - previous.omega) < 1e-4);
      const surge = (time: number) => waterWaveSurge(set, time)[lead]!;
      for (let i = 1; i <= 120; i++) {
        const time = start + i * step, next = bind(time);
        expect(Number.isInteger(next.count)).toBe(true);
        expect(next.phase).toBeGreaterThanOrEqual(0); expect(next.phase).toBeLessThan(TAU);
        if (next.phase < previous.phase) wraps++;
        // The shader's cycle index is floor(phase / 2π) + count: continuous through every wrap, advancing at half the
        // slot's ω (one swash per two waves).
        const change = ((next.phase + TAU * next.count - previous.phase - TAU * previous.count) % span + span * 1.5) % span - span / 2;
        expect(change).toBeCloseTo((next.omega * step - surge(time) + surge(time - step)) * 0.5, 3);
        previous = next;
      }
      expect(wraps).toBeGreaterThanOrEqual(1);
      // Bores travel shoreward on every side of an island: κ outruns the half of the slot's phase that shifts the cycle
      // along a shore. A larger sea runs further up the beach.
      expect(previous.kappa).toBeGreaterThan(0.5 * 0.5 * previous.k);
      expect(previous.excursion).toBeGreaterThan(0);
      definition.waveHeight *= 3;
      expect(bind(start).excursion).toBeGreaterThan(previous.excursion);
      // Flat water has no swash: the shader skips the shore code.
      definition.waveHeight = 0;
      expect(bind(start).excursion).toBe(0);
    } finally { scene.dispose(); engine.dispose(); vi.restoreAllMocks(); }
  });

  it("runs the chop envelopes on two continuous clocks that never come back into step together", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    try {
      const plugin = new WaterMaterialPlugin(new PBRMaterial("water", scene), createDefaultWaterDefinition("stylized"), normalizeWaterBody({}, "global"));
      const output = uniforms();
      plugin.mesh = MeshBuilder.CreateGround("surface", { width: 2, height: 2 }, scene);
      const clocks = (time: number) => {
        plugin.time = time;
        plugin.hardBindForSubMesh(output.buffer, scene);
        const [, , a, b] = output.vectors.get("slateWaterChopShift")!;
        return [a!, b!];
      };
      const TAU = 2 * Math.PI, apart = (x: number) => Math.abs(Math.atan2(Math.sin(x), Math.cos(x)));
      const step = 1 / 12, start = 3600, first = clocks(start);
      // Reduced phases that advance smoothly through every wrap (an envelope's phase is a whole combination of them).
      let previous = first;
      const rates = [0, 0];
      for (let i = 1; i <= 12 * 60; i++) {
        const next = clocks(start + i * step);
        for (const c of [0, 1]) {
          expect(next[c]!).toBeGreaterThanOrEqual(0); expect(next[c]!).toBeLessThan(TAU);
          const advance = ((next[c]! - previous[c]! + TAU) % TAU) / step;
          if (i > 1) expect(advance).toBeCloseTo(rates[c]!, 6);
          rates[c] = advance;
        }
        // For a minute the two clocks never return to their start together: the nearest joint return still leaves one
        // of them about a tenth of a radian or more off (one shared clock returned exactly every 6 s).
        if (i * step >= 2) expect(Math.max(apart(next[0]! - first[0]!), apart(next[1]! - first[1]!))).toBeGreaterThan(0.15);
        previous = next;
      }
      expect(rates[1]! / rates[0]!).toBeCloseTo(Math.SQRT2, 6);
    } finally { scene.dispose(); engine.dispose(); }
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
      // holds (i, j) · L / N in the cascade's turned frame p = R(−θ)·(X, Z), sampled at its centre), whatever the
      // floating origin; the shader turns the eye-relative point by the same R(−θ).
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
        const cos = Math.cos(WATER_FFT_CASCADE_TURNS[c]!), sin = Math.sin(WATER_FFT_CASCADE_TURNS[c]!);
        const turned = (x: number, z: number) => ({ u: cos * x + sin * z, v: cos * z - sin * x });
        const local = turned(rest.x, rest.z), world = turned(origin.x + rest.x, origin.z + rest.z);
        expect(fract(local.u * scale! + offsetU! - (world.u / patch + 0.5 / size) + 0.5) - 0.5).toBeCloseTo(0, 4);
        expect(fract(local.v * scale! + offsetV! - (world.v / patch + 0.5 / size) + 0.5) - 0.5).toBeCloseTo(0, 4);
      }
      // The last cascade fades by its Nyquist wavenumber, π · N / L.
      const last = band.cascades - 1;
      expect(output.vectors.get(`slateWaterFftCascade${last}`)![3]).toBeCloseTo(Math.PI * size / band.patchSizes[last]!, 3);
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

import { describe, expect, it, vi } from "vitest";
import { DirectionalLight, FreeCamera, HemisphericLight, Matrix, MeshBuilder, NullEngine, PBRMaterial, PointLight, Scene, Texture, TransformNode, Vector3, type UniformBuffer } from "@babylonjs/core";
import {
  WATER_WAVE_MAX_COMPONENTS, createDefaultWaterDefinition, createWaterWaveOutput, evaluateWaterWaves, normalizeRenderingQuality, normalizeWaterBody,
  normalizeWaterDefinition, qualityPresetPatch, waterWaveSet, type QualityLevel, type WaterDefinition,
} from "@babylonslate/core";
import { updateSceneRenderingSettings } from "./render-settings";
import { WaterMaterialPlugin } from "./water-material";
import { createWaterMesh, updateSceneWater } from "./water-mesh";
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
      // Preview, editor scenes and Play all build water through createWaterMesh; an edited asset rebuilds it.
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

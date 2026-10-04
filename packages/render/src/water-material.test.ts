import { describe, expect, it, vi } from "vitest";
import { DirectionalLight, FreeCamera, HemisphericLight, Matrix, MeshBuilder, NullEngine, PBRMaterial, PointLight, Scene, Texture, TransformNode, Vector3, type UniformBuffer } from "@babylonjs/core";
import {
  WATER_WAVE_MAX_COMPONENTS, createDefaultWaterDefinition, createWaterWaveOutput, evaluateWaterWaves, normalizeWaterBody, normalizeWaterDefinition,
  waterWaveSet,
} from "@babylonslate/core";
import { WaterMaterialPlugin } from "./water-material";
import { createWaterMesh } from "./water-mesh";
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
      // Classic compiles only its five swell components; Ocean Spectrum adds its other three.
      expect(realistic).not.toContain("#define SLATE_WATER_OCEAN");
      expect(await compiled("stylized", "ocean")).toContain("#define SLATE_WATER_OCEAN");
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

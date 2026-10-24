import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Color3,
  Matrix,
  SphericalPolynomial,
  InputBlock,
  Material,
  MeshBuilder,
  MultiMaterial,
  NullEngine,
  PBRMaterial,
  PointLight,
  RawTexture,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@haptic/shader-graph";
import {
  DEFAULT_RENDER_EFFECTS,
  normalizeCelShadingSettings,
  normalizeEnvironmentLightingSettings,
  normalizeRenderingQuality,
} from "@haptic/core";
import { CelMaterial, celSourceReflectivity, celSourceReflectivityMap } from "./cel-material";
import { celFunctions } from "./cel-shader";
import { compileMaterialPlan } from "./material-compiler";
import { sceneRenderingSettings } from "./render-settings";
import { onSceneReadinessDirty } from "./scene-perf";
import { setSceneRenderSettings } from "./scene-render-mode";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { ResourceCache } from "./resource-cache";
import { applyEnvironmentLighting } from "./environment-lighting";
import { buildFloatDdsCubeFixture } from "@haptic/test-kit/environment-fixtures";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

describe("native CEL render mode", () => {
  it("binds opted-in diffuse irradiance for frozen native and graph CEL without changing the default contribution", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const engine = scene.getEngine();
    const cache = new ResourceCache();
    scene.onDisposeObservable.addOnce(() => cache.dispose());
    const polynomial = new SphericalPolynomial();
    polynomial.yy.set(0.2, 0.7, 0.4);
    vi.spyOn(engine, "createPrefilteredCubeTexture").mockImplementation((url) => {
      const internal = engine.createTexture(url, false, false, null);
      internal.isCube = true;
      internal._sphericalPolynomial = polynomial;
      return internal;
    });
    const settings = { mode: "cel" as const, environmentLighting: normalizeEnvironmentLightingSettings({ intensity: 4 }) };
    setSceneRenderSettings(scene, settings);
    applyEnvironmentLighting(scene, "environment", { resourceCache: cache, textureBytes: new Map([["environment", buildFloatDdsCubeFixture()]]) });
    const source = new PBRMaterial("source", scene);
    const native = new CelMaterial(source, scene);
    const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "graph-environment" });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(await compiled.ready).toEqual([]);
    for (const material of [native, compiled.material]) {
      const mesh = MeshBuilder.CreateBox(material.name, {}, scene);
      mesh.material = material;
      await material.forceCompilationAsync(mesh);
      const subMesh = mesh.subMeshes[0]!;
      expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
      const effect = subMesh.effect!;
      const uniforms = vi.spyOn(effect, "setFloat4");
      material.freeze();
      setSceneRenderSettings(scene, settings);
      material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
      expect(uniforms.mock.calls.filter(([name]) => name === "slateCelEnvironment").at(-1)).toEqual(["slateCelEnvironment", 0, 0, 0, 0]);
      setSceneRenderSettings(scene, { ...settings, environmentLighting: { ...settings.environmentLighting, celStrength: 0.5 } });
      material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
      expect(uniforms.mock.calls.filter(([name]) => name === "slateCelEnvironment").at(-1)).toEqual(["slateCelEnvironment", 2, 0, 0, 0]);
      expect(uniforms.mock.calls.filter(([name]) => name === "slateCelIrradiance_yy").at(-1)).toEqual(["slateCelIrradiance_yy", 0.2, 0.7, 0.4, 0]);
      expect(material.isFrozen).toBe(true);
      uniforms.mockRestore();
    }
    compiled.dispose();
  });
  it("binds only hard-step uniforms and the CEL functions contain no smoothstep", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const native = new CelMaterial(new PBRMaterial("source", scene), scene);
    const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
    mesh.material = native;
    setSceneRenderSettings(scene, {
      mode: "cel",
      cel: normalizeCelShadingSettings({
        shadowBands: 4,
        shadowThreshold: 0.4,
        shadowStrength: 0.7,
        specularStrength: 0.3,
        specularSize: 0.25,
      }),
    });
    await native.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(native.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
    native.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(
      uniforms.mock.calls.filter(([name]) => name === "slateCelBands").at(-1),
    ).toEqual(["slateCelBands", 4, 0.4, 0.7, 0]);
    expect(
      uniforms.mock.calls.filter(([name]) => name === "slateCelSpecular").at(-1),
    ).toEqual(["slateCelSpecular", 0.3, 0.25, 0, 0]);
    for (const wgsl of [false, true])
      expect(celFunctions(wgsl)).not.toContain("smoothstep");
  });

  it("reflects a native source as PBR draws it, never where a texture it cannot read decides", () => {
    const scene = host();
    const metal = new PBRMaterial("metal", scene);
    metal.metallic = 1;
    metal.roughness = 0.25;
    const textured = new PBRMaterial("textured", scene);
    textured.metallic = 1;
    textured.roughness = 1;
    textured.metallicTexture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    const glossy = new PBRMaterial("glossy", scene);
    glossy.reflectivityColor = new Color3(0.5, 0.25, 0);
    glossy.microSurface = 0.75;
    const standard = new StandardMaterial("standard", scene);
    standard.specularColor = new Color3(0.5, 1, 0);
    const cases: [PBRMaterial | StandardMaterial, boolean, number[]][] = [
      // F0 0.04 for non-metals, metalness and glossiness 1 - roughness.
      [metal, false, [0.04, 0.04, 0.04, 1, 0.75]],
      [metal, true, [0, 0, 0, 0, 0]],
      // Metalness from an unread texture stays non-metal: 0.04 is below the reflectivity threshold.
      [textured, false, [0.04, 0.04, 0.04, 0, 0]],
      [glossy, false, [0.5, 0.25, 0, 0, 0.75]],
      // Standard reflectivity is the linear specular color at full gloss.
      [standard, false, [0.2176, 1, 0, 0, 1]],
    ];
    for (const [source, unlit, expected] of cases) {
      const values = celSourceReflectivity(source, unlit);
      expected.forEach((value, index) => expect(values[index]).toBeCloseTo(value, 3));
    }
    standard.specularTexture = textured.metallicTexture;
    expect(celSourceReflectivity(standard, false)).toEqual([0, 0, 0, 0, 0]);
  });

  it("binds the source's reflectivity for the geometry pass and none once the source is unlit", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const source = new PBRMaterial("source", scene);
    source.metallic = 1;
    source.roughness = 0.5;
    const native = new CelMaterial(source, scene);
    const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
    mesh.material = native;
    setSceneRenderSettings(scene, { mode: "cel" });
    await native.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(native.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
    const bound = (name: string) => uniforms.mock.calls.filter(([uniform]) => uniform === name).at(-1)?.slice(1);
    native.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(bound("slateCelReflectivity")).toEqual([0.04, 0.04, 0.04, 1]);
    expect(bound("slateCelTextures")?.[3]).toBe(0.5);
    source.unlit = true;
    native.syncSource();
    native.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(bound("slateCelReflectivity")).toEqual([0, 0, 0, 0]);
  });

  it("reads a source's reflectivity map with the channel conventions its own Material uses in PBR", () => {
    const scene = host();
    const texture = () => RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    // The geometry pass's mapped write for one texel and a linear base color (cel-material.ts, `SPECULAR`).
    const read = (source: PBRMaterial | StandardMaterial, texel: number[], base = 0.5) => {
      const map = celSourceReflectivityMap(source, false);
      if (!map) throw new Error(`${source.name} has no map`);
      const sample = texel.map((value, index) => (index < 3 && map.metal[3] ? value ** 2.2 : value));
      const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
      const metal = map.reflectivity[3] * dot(sample.slice(0, 3), map.metal.slice(0, 3));
      const gloss = Math.min(1, Math.max(0, map.terms[2] + map.terms[3] * (dot(sample, map.gloss) + map.terms[1])));
      const f0 = [0, 1, 2].map((index) => {
        const nonMetal = map.reflectivity[index]! * (map.terms[0] ? sample[index]! : 1);
        return nonMetal + (base - nonMetal) * metal;
      });
      return { f0, metal, gloss };
    };
    const close = (actual: ReturnType<typeof read>, expected: ReturnType<typeof read>) => {
      expect(actual.metal).toBeCloseTo(expected.metal, 3);
      expect(actual.gloss).toBeCloseTo(expected.gloss, 3);
      expected.f0.forEach((value, index) => expect(actual.f0[index]).toBeCloseTo(value, 3));
    };
    // glTF metallic-roughness (ORM): occlusion red, roughness green, metalness blue, scaled by the factors.
    const orm = new PBRMaterial("orm", scene);
    Object.assign(orm, { metallic: 0.5, roughness: 1, metallicTexture: texture() });
    Object.assign(orm, { useRoughnessFromMetallicTextureAlpha: false, useRoughnessFromMetallicTextureGreen: true });
    orm.useMetallnessFromMetallicTextureBlue = true;
    close(read(orm, [0.1, 0.2, 1, 1]), { f0: [0.27, 0.27, 0.27], metal: 0.5, gloss: 0.8 });
    // Babylon's defaults: metalness red, roughness alpha.
    const packed = new PBRMaterial("packed", scene);
    Object.assign(packed, { metallic: 1, roughness: 1, metallicTexture: texture() });
    close(read(packed, [1, 0, 0, 0.25]), { f0: [0.5, 0.5, 0.5], metal: 1, gloss: 0.75 });
    // Neither roughness channel: the factor alone.
    packed.useRoughnessFromMetallicTextureAlpha = false;
    packed.roughness = 0.3;
    close(read(packed, [0, 1, 1, 0]), { f0: [0.04, 0.04, 0.04], metal: 0, gloss: 0.7 });
    // A metallic texture alone selects the metallic workflow, as Babylon does.
    const textureOnly = new PBRMaterial("textureOnly", scene);
    textureOnly.metallicTexture = texture();
    close(read(textureOnly, [1, 0, 0, 0]), { f0: [0.5, 0.5, 0.5], metal: 1, gloss: 1 });
    expect(celSourceReflectivity(textureOnly, false).slice(0, 4)).toEqual([0.04, 0.04, 0.04, 0]);
    // Specular-glossiness: the sRGB map tints the reflectivity color, its alpha scales the microsurface.
    const glossy = new PBRMaterial("glossy", scene);
    Object.assign(glossy, { reflectivityColor: new Color3(1, 0.5, 0.25), microSurface: 0.8, reflectivityTexture: texture() });
    glossy.useMicroSurfaceFromReflectivityMapAlpha = true;
    close(read(glossy, [1, 1, 1, 0.5]), { f0: [1, 0.5, 0.25], metal: 0, gloss: 0.4 });
    // Standard: the linearized specular map, its alpha the glossiness.
    const standard = new StandardMaterial("standard", scene);
    standard.specularTexture = texture();
    close(read(standard, [0.5, 0.5, 0.5, 0.75]), { f0: [0.2176, 0.2176, 0.2176], metal: 0, gloss: 0.75 });
    // Unlit sources and sources without a map read none.
    expect(celSourceReflectivityMap(orm, true)).toBeNull();
    expect(celSourceReflectivityMap(standard, true)).toBeNull();
    expect(celSourceReflectivityMap(new PBRMaterial("flat", scene), false)).toBeNull();
    expect(celSourceReflectivityMap(new StandardMaterial("plain", scene), false)).toBeNull();
  });

  it("binds a source's map only while CEL reflections run with Reflection Textures on", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const source = new PBRMaterial("orm", scene);
    const orm = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    // NullEngine never uploads, so the map would hold compilation back.
    orm.getInternalTexture()!.isReady = true;
    Object.assign(source, { metallic: 1, roughness: 1, metallicTexture: orm });
    Object.assign(source, { useRoughnessFromMetallicTextureAlpha: false, useRoughnessFromMetallicTextureGreen: true });
    source.useMetallnessFromMetallicTextureBlue = true;
    const native = new CelMaterial(source, scene);
    const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
    mesh.material = native;
    const effects = { ...DEFAULT_RENDER_EFFECTS, reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true } };
    const quality = normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } });
    const frame = async (cel: Parameters<typeof normalizeCelShadingSettings>[0]) => {
      setSceneRenderSettings(scene, { mode: "cel", effects, quality, cel: normalizeCelShadingSettings(cel) });
      // A new frame: readiness is cached per render id.
      scene.incrementRenderId();
      await native.forceCompilationAsync(mesh);
      const subMesh = mesh.subMeshes[0]!;
      expect(native.isReadyForSubMesh(mesh, subMesh)).toBe(true);
      const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
      native.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
      const bound = (name: string) => uniforms.mock.calls.filter(([uniform]) => uniform === name).at(-1)?.slice(1);
      return { defines: subMesh.effect!.defines, bound, texture: native.specularTexture };
    };
    const map = ["slateCelReflectivityMetal", "slateCelReflectivityGloss", "slateCelReflectivityMap"];
    // Factors only by default: a textured metalness reads as non-metal, with nothing extra bound or compiled.
    const factors = await frame({ reflectionsEnabled: true });
    expect(factors.texture).toBeNull();
    expect(factors.defines).not.toMatch(/#define SPECULAR\n/);
    expect(factors.bound("slateCelReflectivity")).toEqual([0.04, 0.04, 0.04, 0]);
    for (const name of map) expect(factors.bound(name)).toBeUndefined();
    const textured = await frame({ reflectionsEnabled: true, reflectionTexturesEnabled: true });
    expect(textured.texture).toBe(source.metallicTexture);
    expect(textured.defines).toMatch(/#define SPECULAR\n/);
    expect(textured.bound("slateCelReflectivity")).toEqual([0.04, 0.04, 0.04, 1]);
    expect(textured.bound("slateCelReflectivityMetal")).toEqual([0, 0, 1, 0]);
    expect(textured.bound("slateCelReflectivityGloss")).toEqual([0, 1, 0, 0]);
    // Without CEL reflections running the opt-in binds nothing: the variant is the flat-factor one.
    const flat = await frame({ reflectionsEnabled: false, reflectionTexturesEnabled: true });
    expect(flat.texture).toBeNull();
    expect(flat.defines).toBe(factors.defines);
    for (const name of map) expect(flat.bound(name)).toBeUndefined();
    // A frozen adapter, ready in its flat variant, still follows the setting.
    native.freeze();
    await frame({ reflectionsEnabled: false, reflectionTexturesEnabled: true });
    expect((await frame({ reflectionsEnabled: true, reflectionTexturesEnabled: true })).defines).toBe(textured.defines);
    source.unlit = true;
    native.syncSource();
    expect(native.specularTexture).toBeNull();
  });

  it("adapts imported slots and late meshes, preserving textures, alpha and PBR restoration", () => {
    const scene = host();
    const pbr = new PBRMaterial("imported", scene);
    pbr.albedoColor = new Color3(0.25, 0.5, 0.75);
    pbr.albedoTexture = RawTexture.CreateRGBATexture(
      new Uint8Array([30, 90, 120, 200]),
      1,
      1,
      scene,
    );
    pbr.useAlphaFromAlbedoTexture = true;
    pbr.alpha = 0.7;
    pbr.transparencyMode = Material.MATERIAL_ALPHABLEND;
    pbr.backFaceCulling = false;
    const slots = new MultiMaterial("slots", scene);
    const unlit = new StandardMaterial("sprite", scene);
    unlit.disableLighting = true;
    slots.subMaterials = [pbr, unlit, null];
    const mesh = MeshBuilder.CreateBox("model", {}, scene);
    mesh.material = slots;
    setSceneRenderSettings(scene, { mode: "cel" });
    const celSlots = mesh.material as MultiMaterial;
    const cel = celSlots.subMaterials[0] as CelMaterial;
    expect(cel).toBeInstanceOf(CelMaterial);
    expect(cel).not.toBeInstanceOf(PBRMaterial);
    expect(cel.diffuseTexture).toBe(pbr.albedoTexture);
    expect(cel.useAlphaFromDiffuseTexture).toBe(true);
    expect(cel.alpha).toBe(0.7);
    expect(cel.backFaceCulling).toBe(false);
    expect(celSlots.subMaterials.slice(1)).toEqual([unlit, null]);
    const late = MeshBuilder.CreateBox("late", {}, scene);
    late.material = pbr;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(late.material).toBe(cel);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      cel: normalizeCelShadingSettings({ shadowBands: 8 }),
    });
    expect(mesh.material).toBe(slots);
    expect(late.material).toBe(pbr);
    expect(pbr.albedoColor.asArray()).toEqual([0.25, 0.5, 0.75]);
    expect(isDisposedGpuTexture(pbr.albedoTexture)).toBe(false);
  });

  it("stays idle on unchanged frames: no readiness invalidation or material churn", () => {
    const scene = host();
    const pbr = new PBRMaterial("imported", scene);
    const mesh = MeshBuilder.CreateBox("model", {}, scene);
    mesh.material = pbr;
    setSceneRenderSettings(scene, { mode: "cel" });
    const cel = mesh.material;
    expect(cel).toBeInstanceOf(CelMaterial);
    // The CEL sync is event-driven: clean frames must not re-resolve materials,
    // invalidate the strict readiness cache, or churn mesh.material.
    let marks = 0;
    const off = onSceneReadinessDirty(scene, () => {
      marks += 1;
    });
    for (let frame = 0; frame < 20; frame += 1) {
      scene.onBeforeRenderObservable.notifyObservers(scene);
      expect(mesh.material).toBe(cel);
    }
    expect(marks).toBe(0);
    off();
  });

  it("replaces the material of a mesh added while CEL is active exactly once", () => {
    const scene = host();
    const pbr = new PBRMaterial("imported", scene);
    setSceneRenderSettings(scene, { mode: "cel" });
    const mesh = MeshBuilder.CreateBox("late", {}, scene);
    const assigned = vi.spyOn(mesh, "material", "set");
    mesh.material = pbr;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const cel = mesh.material;
    expect(cel).toBeInstanceOf(CelMaterial);
    // The explicit assignment plus exactly one CEL replacement; scene-lighting
    // separately invalidates readiness for the new material's light defines.
    expect(assigned).toHaveBeenCalledTimes(2);
    for (let frame = 0; frame < 5; frame += 1)
      scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(assigned).toHaveBeenCalledTimes(2);
    expect(mesh.material).toBe(cel);
    assigned.mockRestore();
  });

  it("replaces and restores materials once per PBR ⇄ CEL switch", () => {
    const scene = host();
    const pbr = new PBRMaterial("imported", scene);
    const mesh = MeshBuilder.CreateBox("model", {}, scene);
    mesh.material = pbr;
    const assigned = vi.spyOn(mesh, "material", "set");
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(assigned).toHaveBeenCalledTimes(1);
    const cel = mesh.material;
    expect(cel).toBeInstanceOf(CelMaterial);
    setSceneRenderSettings(scene, { mode: "pbr" });
    expect(assigned).toHaveBeenCalledTimes(2);
    expect(mesh.material).toBe(pbr);
    // The owned replacement is reused rather than rebuilt.
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(assigned).toHaveBeenCalledTimes(3);
    expect(mesh.material).toBe(cel);
    assigned.mockRestore();
  });

  it("replaces a material assigned after CEL was applied on the next frame", () => {
    const scene = host();
    const first = new PBRMaterial("first", scene);
    const other = new PBRMaterial("other", scene);
    const mesh = MeshBuilder.CreateBox("model", {}, scene);
    mesh.material = first;
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(mesh.material).toBeInstanceOf(CelMaterial);
    mesh.material = other;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.material).toBeInstanceOf(CelMaterial);
    expect(mesh.material).not.toBe(other);
    for (let frame = 0; frame < 5; frame += 1)
      scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.material).not.toBe(other);
  });

  it("switches authored graphs in place and preserves frozen materials and live parameters", async () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes[0] = {
      ...doc.nodes[0]!,
      type: "param.color",
      properties: { name: "Tint", value: [0.2, 0.6, 0.3, 1] },
    };
    doc.edges[0]!.sourcePinId = "rgb";
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "authored",
    });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(await compiled.ready).toEqual([]);
    const material = compiled.material;
    const mesh = MeshBuilder.CreateBox("actor", {}, scene);
    mesh.material = material;
    for (let i = 0; i < 6; i++)
      new PointLight(`light-${i}`, new Vector3(i, 3, 0), scene);
    material.freeze();
    // First activation loads CEL blocks asynchronously. Rapid switches must
    // settle on the last request rather than lose a build or mix graph roots.
    setSceneRenderSettings(scene, { mode: "cel" });
    setSceneRenderSettings(scene, { mode: "pbr" });
    await vi.waitFor(() =>
      expect(material.compiledShaders).toContain("pbrBlockAlbedoOpacity"),
    );
    setSceneRenderSettings(scene, { mode: "cel" });
    // NullEngine's non-UBO path admits four conventional lights.
    expect(material.maxSimultaneousLights).toBe(4);
    await vi.waitFor(() =>
      expect(material.compiledShaders).toContain("slateCelSurfaceLight"),
    );
    expect(material.compiledShaders).not.toContain("pbrBlockAlbedoOpacity");
    material.freeze();
    expect(
      compiled.setParameter("Tint", {
        kind: "color",
        value: [0.1, 0.4, 0.8, 1],
      }),
    ).toBe(true);
    setSceneRenderSettings(scene, { mode: "pbr" });
    await vi.waitFor(() =>
      expect(material.compiledShaders).toContain("pbrBlockAlbedoOpacity"),
    );
    expect(mesh.material).toBe(material);
    expect(material.isFrozen).toBe(true);
    const tint = material.getBlockByName("baseColor") as InputBlock;
    expect(tint.value.asArray()).toEqual([0.1, 0.4, 0.8, 1]);
    setSceneRenderSettings(scene, { mode: "cel" });
    await vi.waitFor(() =>
      expect(material.compiledShaders).toContain("slateCelSurfaceLight"),
    );
    expect(mesh.material).toBe(material);
    expect(material.isFrozen).toBe(true);
    expect(material.getBlockByName("baseColor")).toBe(tint);
    expect(
      compiled.setParameter("Tint", {
        kind: "color",
        value: [0.8, 0.2, 0.1, 1],
      }),
    ).toBe(true);
    expect(tint.value.asArray()).toEqual([0.8, 0.2, 0.1, 1]);
    compiled.dispose();
    expect(sceneRenderingSettings(scene).listeners.size).toBe(0);
  });

  it("connects a CEL graph's reflectivity only while reflections run", async () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    Object.assign(doc.nodes.find((node) => node.id === "output")!.properties, { "default:metallic": [1], "default:roughness": [0.25] });
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "metal" });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(await compiled.ready).toEqual([]);
    const material = compiled.material;
    const errors: string[] = [];
    material.onBuildErrorObservable.add((error) => errors.push(error));
    MeshBuilder.CreateBox("actor", {}, scene).material = material;
    const effects = { ...DEFAULT_RENDER_EFFECTS, reflections: { ...DEFAULT_RENDER_EFFECTS.reflections, enabled: true } };
    const quality = normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } });
    const render = (reflectionsEnabled: boolean) =>
      setSceneRenderSettings(scene, { mode: "cel", effects, quality, cel: normalizeCelShadingSettings({ reflectionsEnabled }) });
    // The F0 mix of the geometry reflectivity write, present only with base color connected.
    const reflective = "mix(vec3(0.04)";
    render(false);
    await vi.waitFor(() => expect(material.compiledShaders).toContain("slateCelSurfaceLight"));
    expect(material.compiledShaders).not.toContain(reflective);
    render(true);
    await vi.waitFor(() => expect(material.compiledShaders).toContain(reflective));
    expect(material.compiledShaders).toContain("slateCelSurfaceLight");
    render(false);
    await vi.waitFor(() => expect(material.compiledShaders).not.toContain(reflective));
    expect(errors).toEqual([]);
    compiled.dispose();
  });

  it("resolves scene overrides without leaking them between scenes or into PBR", () => {
    const a = host();
    const b = host();
    const project = {
      mode: "cel" as const,
      cel: normalizeCelShadingSettings({
        shadowBands: 4,
        specularStrength: 0.3,
      }),
    };
    setSceneRenderSettings(a, project, { shadowBands: 7 });
    setSceneRenderSettings(b, project);
    expect(sceneRenderingSettings(a).cel.shadowBands).toBe(7);
    expect(sceneRenderingSettings(b).cel.shadowBands).toBe(4);
    setSceneRenderSettings(a, {
      ...project,
      cel: { ...project.cel, specularStrength: 0.6 },
    });
    expect(sceneRenderingSettings(a).cel).toMatchObject({
      shadowBands: 7,
      specularStrength: 0.6,
    });
    setSceneRenderSettings(a, undefined, {});
    expect(sceneRenderingSettings(a).cel.shadowBands).toBe(4);
    setSceneRenderSettings(a, { ...project, mode: "pbr" }, { shadowBands: 8 });
    expect(sceneRenderingSettings(a).mode).toBe("pbr");
    expect(sceneRenderingSettings(b).mode).toBe("cel");
  });
});

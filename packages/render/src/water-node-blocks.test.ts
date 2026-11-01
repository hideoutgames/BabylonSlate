import { afterEach, describe, expect, it, vi } from "vitest";
import { Color3, FreeCamera, Matrix, MeshBuilder, Vector3, NullEngine, Scene, ShaderLanguage, type AbstractMesh, type Mesh, type NodeMaterial } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody } from "@haptic/core";
import { createDefaultMaterialDocument, createWaterMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { acquireAuthoredMaterialVariant, acquireWaterVariant, compileMaterialPlan, waterVariantBase, type CompiledMaterial } from "./material-compiler";
import { MaterialLibrary } from "./material-library";
import { updateSceneRenderingSettings } from "./render-settings";
import { createWaterMesh, sceneWaterSamplesSceneCopy, updateSceneWater, waterMeshReflectsObjects, waterMeshSamplesSceneCopy } from "./water-mesh";
import { materialSceneCopyUse, meshWaterNodeSurface, WaterCoverageBlock, WaterCutBlock } from "./water-node-blocks";
import { createWaterRemovalMesh } from "./water-removal-mesh";
import type { WaterField } from "./water-field";
import { placeholderField, waterGridOffset } from "./water-material";
import { registerSpatialGeometryPass, unregisterSpatialGeometryPass } from "./spatial-geometry-passes";
import { builtInWaterMaterial } from "./water-template";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.restoreAllMocks(); });

function host(webgpu = false): Scene {
  const engine = new NullEngine(), scene = new Scene(engine);
  if (webgpu) vi.spyOn(engine, "isWebGPU", "get").mockReturnValue(true);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return scene;
}

type Wire = readonly [node: string, pin: string, target: string];
/** A Surface graph of `nodes` (id = type suffix), each output wired to a Material Output pin. */
function graph(nodes: readonly string[], wires: readonly Wire[], blendMode: MaterialDocument["blendMode"] = "opaque"): MaterialDocument {
  const doc = createDefaultMaterialDocument("Water");
  doc.blendMode = blendMode;
  doc.edges = doc.edges.filter((edge) => !wires.some(([, , target]) => edge.targetNodeId === "output" && edge.targetPinId === target));
  for (const id of nodes) doc.nodes.push({ id, type: `input.${id}`, position: { x: 0, y: 0 }, properties: {} });
  for (const [node, pin, target] of wires) doc.edges.push({ id: `${node}-${pin}-${target}`, sourceNodeId: node, sourcePinId: pin, targetNodeId: "output", targetPinId: target });
  return doc;
}
/** Every water node with Water Waves: the waves displace and shade, the others feed colour, roughness and opacity. */
const allNodes = (blendMode: MaterialDocument["blendMode"] = "translucent") => graph(
  ["waterWaves", "waterFoam", "waterDepthFade", "waterSceneColor", "waterReflection"],
  [["waterWaves", "offset", "worldPositionOffset"], ["waterWaves", "normal", "normal"], ["waterReflection", "color", "baseColor"],
    ["waterSceneColor", "color", "emissive"], ["waterFoam", "foam", "roughness"], ["waterDepthFade", "fade", "opacity"], ["waterReflection", "fresnel", "metallic"]],
  blendMode,
);

function compile(scene: Scene, doc: MaterialDocument) {
  const plan = lowerMaterialDocument(doc);
  if (!plan.ok) throw new Error(JSON.stringify(plan.diagnostics));
  const result = compileMaterialPlan(plan.plan, { scene, name: "water" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  disposers.push(result.dispose);
  return result;
}

/** `result`'s water variant (`acquireWaterVariant`), built, held until the test ends. */
async function waterVariantOf(result: CompiledMaterial): Promise<NodeMaterial> {
  const variant = acquireWaterVariant(result.material)!;
  disposers.push(() => void variant.release());
  expect(await variant.compiled.ready).toEqual([]);
  return variant.compiled.material;
}

async function programFor(material: NodeMaterial, mesh: AbstractMesh) {
  await material.forceCompilationAsync(mesh);
  expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
  return mesh.subMeshes[0]!.effect!;
}
async function definesFor(material: NodeMaterial, mesh: AbstractMesh): Promise<string> {
  return (await programFor(material, mesh)).defines as string;
}
/** A camera looking down at the origin, so water there is in view (its frame update runs) and binds a projection. */
function overlook(scene: Scene): void {
  const camera = new FreeCamera("camera", new Vector3(0, 10, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  scene.setTransformMatrix(camera.getViewMatrix(), camera.getProjectionMatrix());
}
/** The reflection march's function text. */
const march = (source: string) => /swMarch\(swOrigin[\s\S]*?\n\}/.exec(source)?.[0] ?? "";

describe("Water material nodes", () => {
  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("compile together with Water Waves in language %s, every prefix bound", async (language) => {
    const wgsl = language === ShaderLanguage.WGSL, result = compile(host(wgsl), allNodes());
    expect(await result.ready).toEqual([]);
    const source = result.material.compiledShaders, [, fragment = ""] = source.split("// Fragment shader");
    expect(source).not.toMatch(/\b[UAOS]\.slate|\bIN\.|\bU\.\w/);
    // GLSL rejects a sampler declared twice in one stage.
    const [vertex = ""] = source.split("// Fragment shader");
    const declarations = (stage: string, name: string) => stage.split(wgsl ? `var ${name}: texture_` : ` ${name};`).length - 1;
    for (const name of ["slateWaterFftSampler", "slateWaterFoamSampler", "slateWaterFieldSampler", "slateWaterContactSampler", "slateWaterSceneSampler", "slateWaterNodeEnvSampler", "slateWaterNodePlanarSampler"]) {
      expect(declarations(fragment, name), name).toBe(1);
    }
    expect(declarations(vertex, "slateWaterFftSampler")).toBe(1);
    // Every preprocessor directive stands on its own line.
    expect(source).not.toMatch(/\bsw\w*[^\n]*\S#(ifdef|endif|if|else)\b/);
    for (const helper of ["swnFieldAt", "swnContactAt", "swSceneDepth", "swMarch", "swnEnvTap", "swnNoise", "swPlanarTexel"]) expect(fragment, helper).toContain(helper);
    // The terrain and contact fields read the water mesh's data, the copy only with the pass's copy, the cube only with a cube.
    const sampler = (name: string) => wgsl ? `var ${name}: texture_` : ` ${name};`;
    for (const [name, define] of [["slateWaterFieldSampler", "SLATE_WATER_SURFACE"], ["slateWaterSceneSampler", "SLATE_WATER_NODE_COPY"], ["slateWaterNodeEnvSampler", "SLATE_WATER_NODE_ENV"], ["slateWaterNodePlanarSampler", "SLATE_WATER_NODE_PLANAR"]] as const) {
      expect(fragment).toMatch(new RegExp(`#ifdef ${define}\\s+[^#]*${sampler(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    if (wgsl) {
      expect(fragment).not.toMatch(/^\s*(float|vec[234]) \w+ =/m);
      expect(fragment).toContain("fragmentInputs.position.xy");
      expect(fragment).toContain("fn swMarch(swOrigin: vec3f, swRay: vec3f, swVP: mat4x4f, swV: mat4x4f, swEyeP: vec3f) -> vec4f {");
      expect(march(fragment)).not.toMatch(/scene\.(view|vEyePosition)/);
    } else {
      expect(fragment).toContain("gl_FragCoord.xy");
      expect(fragment).toContain("vec4 swMarch(vec3 swOrigin, vec3 swRay, mat4 swVP, mat4 swV, vec3 swEyeP) {");
      expect(march(fragment)).not.toMatch(/\bvEyePosition\b|\(view \*/);
    }
  });

  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])(
    "build the starter water Material in language %s, displacing and shading every kind of water body", async (language) => {
      const scene = host(language === ShaderLanguage.WGSL), doc = createWaterMaterialDocument("Sea");
      const plan = lowerMaterialDocument(doc);
      expect(plan.ok && plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const result = compile(scene, doc);
      expect(await result.ready).toEqual([]);
      // Its Opacity fades at the body's edges, and its refraction falls back beside silhouettes, as built-in water's.
      const [, fragment = ""] = result.material.compiledShaders.split("// Fragment shader");
      expect(fragment).toMatch(/\w+ = swEdgeFade \* swOpenFade;/);
      // Its shoreline under the waves comes from four terrain taps, whose slope softens gentle shores, as built-in water's.
      expect(fragment).toMatch(/if \((uniforms\.)?slateWaterFieldStep\.w > 0\.0 && swnField\.w > [\d.]+\) \{/);
      expect(fragment).toMatch(/swShoreSlope = mix\(length\(swTerrainSlope\), 1\.0, swFineClamped\);/);
      expect(fragment).toMatch(/smoothstep\(0\.35, 1\.0, swShoreSlope\)/);
      expect(fragment).toContain("swCopyTexel");
      // It lets nothing through over open sky, nor one copy texel in from it: a multisampled silhouette's resolved colour
      // there holds the background while its depth is the surface's (dark dashes along a submerged landscape's border).
      expect(fragment).toMatch(/swnOpenSky = step\([\d.]+, max\(swnSceneZ, swnNearSky\)\);/);
      // Its lighting takes Water Reflection's normal: the half vector toward the reflected ray, lifted above the horizon
      // as built-in water lifts it, from the waves' normal flattened by the horizon haze through the scene's fog.
      expect(fragment).toMatch(/\w+ = swnH;/);
      expect(fragment).toMatch(/swnRLiftA(: f32)? = 60\.0 \* \(0\.03 - swnR\.y\)/);
      // What it refracts was fogged by what lies below: it comes undone of the Material's own fog, by the same factor.
      expect(fragment).toMatch(/swnFogKeep(: f32)? = max\(sceneFogKeep\([^;]*\), 0\.01\);/);
      expect(fragment).toMatch(/= \(\w+ - (uniforms\.)?sceneFogColor\.rgb \* \(1\.0 - swnFogKeep\)\) \/ swnFogKeep;/);
      // Its Roughness is built-in water's slope-variance roughness, which drops away under the haze.
      expect(fragment).toMatch(/\w+ = swnShade;/);
      expect(fragment).toMatch(/swnShadeVar(: f32)? = \(max\([^;]*\* \(1\.0 - 0\.97 \* swHaze\);/);
      expect(fragment).toMatch(/swnAirKeep = max\(sceneFogKeep\(/);
      // Every fog term is the one rule surfaces fog by: Babylon PBR's linear-space factor.
      expect(fragment).toMatch(/sceneFogKeep\((vec3 )?viewPosition[^)]*\)[^{]*\{ return toLinearSpace\(CalcFogFactor\(viewPosition, (uniforms\.)?sceneFogInfo\)\); \}/);
      // It is seen from below too, as built-in water is.
      expect(result.material.backFaceCulling).toBe(false);
      // NullEngine has no lit WGSL includes to draw a mesh with.
      if (language === ShaderLanguage.WGSL) return;
      for (const kind of ["ocean", "lake", "river", "puddle", "global"] as const) {
        const body = createWaterMesh(scene, kind, normalizeWaterBody({ resolution: 8 }, kind), createDefaultWaterDefinition(), result.material);
        expect(await definesFor(result.material, body), kind).toMatch(/^#define SLATE_WATER_GPU_WAVES$/m);
        // It shows what lies below through the scene copy, which only a translucent Material can read.
        expect(result.material.needAlphaBlendingForMesh(body), kind).toBe(true);
        // A graph that reads terrain and contacts (its foam and depth) has the water mesh build them.
        expect(meshWaterNodeSurface(body)?.contacts ?? null, kind).not.toBeNull();
        body.dispose();
      }
    });

  it("give Water Colors the asset's own colours beside a Water Waves node", async () => {
    const scene = host(), water = { ...createDefaultWaterDefinition(), foamColor: [0.9, 0.5, 0.1] as [number, number, number] };
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    new FreeCamera("camera", new Vector3(0, 6, -12), scene);
    const result = compile(scene, graph(["waterWaves", "waterColors"], [["waterWaves", "offset", "worldPositionOffset"], ["waterWaves", "crestFoam", "roughness"], ["waterColors", "foamColor", "baseColor"]]));
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), water, result.material);
    await definesFor(result.material, lake);
    const effect = lake.subMeshes[0]!.effect!, bound = new Map<string, number[][]>();
    vi.spyOn(effect, "setFloat4").mockImplementation((name, x, y, z, w) => { bound.set(name, [...bound.get(name) ?? [], [x, y, z, w]]); return effect; });
    result.material.bindForSubMesh(lake.computeWorldMatrix(true), lake, lake.subMeshes[0]!);
    // The Foam Color output reads its own uniform: every block that binds it writes the linear Foam Color.
    const read = /(\w+) = (\w+)\.rgb;/.exec(result.material.compiledShaders.split("// Fragment shader")[1]!.match(/\w+ = slateWaterNode\w*Foam\w*\.rgb;/)![0])![2]!;
    const linear = new Color3(0.9, 0.5, 0.1).toLinearSpace(scene.getEngine().useExactSrgbConversions);
    const expected = [linear.r, linear.g, linear.b].map((v) => Number(v.toFixed(5)));
    expect(bound.get(read)!.map((value) => value.slice(0, 3).map((v) => Number(v.toFixed(5))))).toEqual(bound.get(read)!.map(() => expected));
  });

  it("bind the scene's fog and its linear colour for Water Scene Color's pre-division", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    new FreeCamera("camera", new Vector3(0, 6, -12), scene);
    Object.assign(scene, { fogMode: Scene.FOGMODE_LINEAR, fogStart: 10, fogEnd: 50, fogColor: new Color3(0.6, 0.3, 0.9) });
    const result = compile(scene, graph(["waterSceneColor"], [["waterSceneColor", "color", "emissive"]], "translucent"));
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    await definesFor(result.material, lake);
    const effect = lake.subMeshes[0]!.effect!, bound = new Map<string, number[]>();
    vi.spyOn(effect, "setFloat4").mockImplementation((name, x, y, z, w) => { bound.set(name, [x, y, z, w]); return effect; });
    result.material.bindForSubMesh(lake.computeWorldMatrix(true), lake, lake.subMeshes[0]!);
    expect(bound.get("sceneFogInfo")).toEqual([Scene.FOGMODE_LINEAR, 10, 50, scene.fogDensity]);
    const linear = new Color3(0.6, 0.3, 0.9).toLinearSpace(scene.getEngine().useExactSrgbConversions);
    expect(bound.get("sceneFogColor")!.map((v) => Number(v.toFixed(5)))).toEqual([linear.r, linear.g, linear.b, 0].map((v) => Number(v.toFixed(5))));
  });

  it("bind whether the asset's waves move the shoreline, for the four-tap shoreline over terrain", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    new FreeCamera("camera", new Vector3(0, 6, -12), scene);
    const result = compile(scene, graph(["waterDepthFade"], [["waterDepthFade", "edgeFade", "opacity"]], "translucent"));
    expect(await result.ready).toEqual([]);
    for (const [water, waves] of [[createDefaultWaterDefinition(), 1], [{ ...createDefaultWaterDefinition(), waveHeight: 0 }, 0]] as const) {
      const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), water, result.material);
      await definesFor(result.material, lake);
      // Terrain under the lake (any texture stands in for its field here).
      meshWaterNodeSurface(lake)!.field = { texture: placeholderField(scene), bounds: [0, 0, 0.1, 0.1], depthRange: [-4, 2], texelSize: [0.01, 0.01], fineDepthMin: -1, fineDepthSpan: 2 } as unknown as WaterField;
      const effect = lake.subMeshes[0]!.effect!, bound = new Map<string, number[]>();
      vi.spyOn(effect, "setFloat4").mockImplementation((name, x, y, z, w) => { bound.set(name, [x, y, z, w]); return effect; });
      result.material.bindForSubMesh(lake.computeWorldMatrix(true), lake, lake.subMeshes[0]!);
      expect(bound.get("slateWaterFieldStep")).toEqual([0.01, 0.01, 2, waves]);
      lake.dispose();
    }
  });

  it("mix Water Colors toward a differently coloured neighbour where the bodies blend", async () => {
    const scene = host(), own = createDefaultWaterDefinition(), red = { ...own, shallowColor: [1, 0.2, 0.2] as [number, number, number] };
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    new FreeCamera("camera", new Vector3(0, 30, -40), scene);
    const result = compile(scene, graph(["waterWaves", "waterColors"], [["waterWaves", "offset", "worldPositionOffset"], ["waterColors", "shallowColor", "baseColor"]]));
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 24, length: 24, resolution: 16 }), own, result.material);
    const neighbour = createWaterMesh(scene, "neighbour", normalizeWaterBody({ width: 24, length: 24, resolution: 16 }), red, builtInWaterMaterial(scene));
    neighbour.position.set(18, 0, 0);
    updateSceneWater(scene);
    expect(await definesFor(result.material, lake)).toMatch(/^#define SLATE_WATER_NODE_BLEND$/m);
    const slot = meshWaterNodeSurface(lake)!.partners.findIndex((partner) => partner?.shallowColor[0] === 1);
    expect(slot).toBeGreaterThanOrEqual(0);
    const effect = lake.subMeshes[0]!.effect!, bound = new Map<string, number[]>();
    vi.spyOn(effect, "setFloat4").mockImplementation((name, x, y, z, w) => { bound.set(name, [x, y, z, w]); return effect; });
    result.material.bindForSubMesh(lake.computeWorldMatrix(true), lake, lake.subMeshes[0]!);
    // That partner's slot carries the neighbour's Shallow Color, which the shader mixes in by the vertex's share.
    const linear = new Color3(1, 0.2, 0.2).toLinearSpace(scene.getEngine().useExactSrgbConversions);
    expect(bound.get(`slateWaterNodeShallowColor${slot}`)!.slice(0, 3)).toEqual([linear.r, linear.g, linear.b].map((v) => expect.closeTo(v, 5)));
    expect(result.material.compiledShaders).toMatch(new RegExp(`slateWaterNodeShallowColor${slot}\\.rgb \\* vSlateWaterNodeShares\\.`));
  });

  it("compile without Water Waves, where Crest Foam and the per-pixel Normal fall back", async () => {
    const result = compile(host(), graph(["waterFoam", "waterReflection", "waterSceneColor"],
      [["waterFoam", "crestFoam", "roughness"], ["waterFoam", "foam", "metallic"], ["waterReflection", "color", "baseColor"], ["waterSceneColor", "color", "emissive"]]));
    expect(await result.ready).toEqual([]);
    const source = result.material.compiledShaders;
    expect(source).not.toMatch(/swnFoam|slateWaterFftSampler|SLATE_WATER_GPU_WAVES \d/);
    expect(source).toMatch(/swnN = normalize\(vec3\(0\.0, 1\.0, 0\.0\)\);/);
  });

  it("keep neutral outputs off water meshes and read the mesh's data on water", async () => {
    const scene = host(), result = compile(scene, allNodes());
    expect(await result.ready).toEqual([]);
    const ordinary = MeshBuilder.CreateGround("ordinary", {}, scene);
    ordinary.material = result.material;
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    const [plain, water] = [await definesFor(result.material, ordinary), await definesFor(result.material, lake)];
    expect(plain).not.toMatch(/^#define SLATE_WATER_SURFACE$/m);
    expect(water).toMatch(/^#define SLATE_WATER_SURFACE$/m);
    // No view registered a scene copy for this pass: the copy features compile out.
    expect(water).not.toMatch(/^#define SLATE_WATER_NODE_COPY$/m);
    expect(water).toMatch(/^#define SLATE_WATER_SSR_STEPS 0$/m);
  });

  it("give every Custom Material water mesh terrain and contact fields, which its cut reads for land above the water", async () => {
    const scene = host(), water = createDefaultWaterDefinition();
    const reflection = compile(scene, graph(["waterReflection"], [["waterReflection", "color", "baseColor"]]));
    const mirror = createWaterMesh(scene, "mirror", normalizeWaterBody({ resolution: 8 }), water, reflection.material);
    expect(meshWaterNodeSurface(mirror)?.field).not.toBeNull();
    expect(meshWaterNodeSurface(mirror)?.contacts).not.toBeNull();
  });

  it("mirror the view's planar reflection from a level body with Object Reflections at Planar quality, binding it on every draw", async () => {
    const scene = host();
    overlook(scene);
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { reflections: "planar" } }) });
    const result = compile(scene, graph(["waterReflection"], [["waterReflection", "color", "emissive"]]));
    expect(await result.ready).toEqual([]);
    const water = { ...createDefaultWaterDefinition(), objectReflections: true };
    const body = (name: string, definition = water, kind?: "river") =>
      createWaterMesh(scene, name, normalizeWaterBody({ resolution: 8 }, kind), definition, result.material);
    const lake = body("lake"), river = body("river", water, "river"), dull = body("dull", { ...water, objectReflections: false });
    const plain = compile(scene, createDefaultMaterialDocument("Plain"));
    const unreflecting = createWaterMesh(scene, "unreflecting", normalizeWaterBody({ resolution: 8 }), water, plain.material);
    updateSceneWater(scene);
    // Only water whose graph reads Water Reflection can take the view's mirror.
    expect([lake, river, dull, unreflecting].map(waterMeshReflectsObjects)).toEqual([true, true, false, false]);
    const planar = /^#define SLATE_WATER_NODE_PLANAR$/m;
    expect(await definesFor(result.material, lake)).toMatch(planar);
    for (const mesh of [river, dull]) expect(await definesFor(result.material, mesh), mesh.name).not.toMatch(planar);
    // No view drew a mirror: the planar uniform selects the march, and the sampler is still bound, as WebGPU needs.
    const effect = await programFor(result.material, lake), vectors = new Map<string, number[]>(), textures: string[] = [];
    vi.spyOn(effect, "setFloat4").mockImplementation((name, x, y, z, w) => { vectors.set(name, [x, y, z, w]); return effect; });
    vi.spyOn(effect, "setTexture").mockImplementation((name) => { textures.push(name); });
    result.material.bindForSubMesh(lake.computeWorldMatrix(true), lake, lake.subMeshes[0]!);
    expect(vectors.get("slateWaterNodePlanar")?.[0]).toBe(0);
    expect(textures).toContain("slateWaterNodePlanarSampler");
  });

  it("re-prepare a frozen Material's water defines when the Water quality changes or a volume tilts out of level", async () => {
    const scene = host(), result = compile(scene, graph(["waterReflection"], [["waterReflection", "color", "emissive"]]));
    overlook(scene);
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    updateSceneWater(scene);
    const drawn = lake.material as NodeMaterial;
    await definesFor(drawn, lake);
    drawn.freeze();
    const dirty = vi.spyOn(drawn, "markDirty");
    updateSceneWater(scene);
    expect(dirty).not.toHaveBeenCalled();
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { reflections: "sky" } }) });
    updateSceneWater(scene);
    expect(dirty).toHaveBeenCalledTimes(1);
    lake.rotation.x = 0.2;
    updateSceneWater(scene);
    expect(meshWaterNodeSurface(lake)?.flat).toBe(false);
    expect(dirty).toHaveBeenCalledTimes(2);
  });

  it("ask for the view's scene copy as built-in water does, only from alpha-blended water", () => {
    const scene = host();
    const blended = compile(scene, allNodes("translucent")), opaque = compile(scene, allNodes("opaque"));
    expect(materialSceneCopyUse(blended.material)).toEqual({ refraction: true, reflection: true });
    const water = createDefaultWaterDefinition();
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), { ...water, objectReflections: false }, blended.material);
    const pond = createWaterMesh(scene, "pond", normalizeWaterBody({ resolution: 8 }), water, opaque.material);
    updateSceneWater(scene);
    expect(sceneWaterSamplesSceneCopy(scene, true, false)).toBe(true);
    // Object reflections follow the asset: off on the blended lake, and the opaque pond draws before any copy exists.
    expect(waterMeshSamplesSceneCopy(lake, true, false)).toBe(true);
    expect(waterMeshSamplesSceneCopy(lake, false, true)).toBe(false);
    expect(waterMeshSamplesSceneCopy(pond, true, true)).toBe(false);
    lake.dispose(); pond.dispose();
    updateSceneWater(scene);
    expect(sceneWaterSamplesSceneCopy(scene, true, true)).toBe(false);
  });
});

/**
 * `source` as the level of Water Shading Detail draws it: only `#if SLATE_WATER_DETAIL >= n` blocks are evaluated (their
 * `#else` too), every other directive and line is kept. GLSL Effects keep their conditionals for the driver.
 */
function atDetail(source: string, level: number): string {
  const out: string[] = [], stack: { mine: boolean; parent: boolean; pass: boolean }[] = [];
  let keep = true;
  for (const line of source.split("\n")) {
    const directive = line.trim(), mine = /^#if SLATE_WATER_DETAIL >= (\d)$/.exec(directive);
    if (mine) { stack.push({ mine: true, parent: keep, pass: level >= Number(mine[1]) }); keep = keep && level >= Number(mine[1]); continue; }
    if (/^#if/.test(directive)) stack.push({ mine: false, parent: keep, pass: true });
    const top = stack[stack.length - 1];
    if (directive === "#else" && top?.mine) { keep = top.parent && !top.pass; continue; }
    if (directive === "#endif" && top) {
      stack.pop();
      if (top.mine) { keep = top.parent; continue; }
    }
    if (keep) out.push(line);
  }
  return out.join("\n");
}

describe("Water Shading Detail", () => {
  const starter = (scene: Scene) => {
    const result = compile(scene, createWaterMaterialDocument("Sea"));
    const water = { ...createDefaultWaterDefinition(), objectReflections: true };
    return { result, lake: createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), water, result.material) };
  };
  const detail = (scene: Scene, shadingDetail: "low" | "medium" | "high" | "ultra", reflections: "sky" | "screenSpace" | "planar" = "sky") =>
    updateSceneRenderingSettings(scene, { quality: normalizeRenderingQuality({ water: { shadingDetail, reflections } }) });

  it.each([
    // Shoreline taps, contact foam, edge foam's finer octaves, the silhouette fallback.
    ["low", 0, [false, false, false, false]],
    ["medium", 1, [true, true, true, false]],
    ["high", 2, [true, true, true, true]],
    ["ultra", 3, [true, true, true, true]],
  ] as const)("at %s draws the water nodes' terms of level %i", async (level, value, terms) => {
    const scene = host();
    overlook(scene);
    detail(scene, level);
    const { result, lake } = starter(scene);
    expect(await result.ready).toEqual([]);
    const effect = await programFor(result.material, lake);
    expect(effect.defines).toMatch(new RegExp(`^#define SLATE_WATER_DETAIL ${value}$`, "m"));
    const fragment = atDetail(effect.fragmentSourceCode, value);
    expect([
      fragment.includes("swTerrainSlope"),
      /swnContactAmount = swnContactFoamAmount\(/.test(fragment),
      fragment.includes("p * 6.1"),
      fragment.includes("swCopyTexel"),
    ]).toEqual(terms);
    // Cheap terms stay at every level: the haze and aerial perspective, the slope-variance roughness, the transmittance
    // and edge foam's broadest noise.
    for (const kept of ["swAirOn", "swHaze =", "swnShadePixel", "swnTCosT", "p * 0.7"]) expect(fragment, kept).toContain(kept);
  });

  it("never overrides the Reflections setting: Low still mirrors the view's planar reflection", async () => {
    const scene = host();
    overlook(scene);
    detail(scene, "low", "planar");
    const { result, lake } = starter(scene);
    expect(await result.ready).toEqual([]);
    updateSceneWater(scene);
    const defines = await definesFor(result.material, lake);
    expect(defines).toMatch(/^#define SLATE_WATER_DETAIL 0$/m);
    expect(defines).toMatch(/^#define SLATE_WATER_NODE_PLANAR$/m);
  });

  it("compiles nothing while the level is unchanged, a variant for another level and the first again when it returns", async () => {
    const scene = host();
    overlook(scene);
    detail(scene, "medium");
    const { result, lake } = starter(scene);
    expect(await result.ready).toEqual([]);
    const medium = await programFor(result.material, lake);
    const create = vi.spyOn(scene.getEngine(), "createEffect");
    for (let frame = 0; frame < 3; frame++) {
      scene.incrementRenderId();
      updateSceneWater(scene);
      expect(result.material.isReadyForSubMesh(lake, lake.subMeshes[0]!)).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();
    expect(lake.subMeshes[0]!.effect).toBe(medium);
    detail(scene, "low");
    scene.incrementRenderId();
    const low = await programFor(result.material, lake);
    expect(low).not.toBe(medium);
    expect(low.defines).toMatch(/^#define SLATE_WATER_DETAIL 0$/m);
    detail(scene, "medium");
    scene.incrementRenderId();
    expect(await programFor(result.material, lake)).toBe(medium);
  });
});

describe("Water Cut", () => {
  const stages = (source: string) => { const [vertex = "", fragment = ""] = source.split("// Fragment shader"); return { vertex, fragment }; };

  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("is only in a Surface Material's water variant, and discards removed water last in language %s", async (language) => {
    const wgsl = language === ShaderLanguage.WGSL, result = compile(host(wgsl), createDefaultMaterialDocument("Plain"));
    expect(await result.ready).toEqual([]);
    // The base Material carries none of the cut: no removal code, uniforms or water defines.
    const base = result.material.compiledShaders;
    expect(base).not.toMatch(/swRemoval|slateWater|DEPTHPREPASS|SLATE_WATER_EFFECTS_GEOMETRY/);
    const source = (await waterVariantOf(result)).compiledShaders, { vertex, fragment } = stages(source);
    expect(source).not.toMatch(/\bU\.\w|\bIN\.|\b[AO]\.slate/);
    expect(fragment.split(wgsl ? "fn swRemoval(" : "float swRemoval(").length - 1).toBe(1);
    for (let i = 0; i < 4; i++) expect(fragment).toContain(wgsl ? `uniform slateWaterRemoval${i}: mat4x4f;` : `uniform mat4 slateWaterRemoval${i};`);
    if (wgsl) expect(fragment).not.toMatch(/^\s*(float|vec[234]|bool) \w+ =/m);
    // The depth pre-pass leaves at once; the colour pass discards only after the output is written.
    const prePass = new RegExp(`#ifdef DEPTHPREPASS\\s+if \\((\\w+)\\) \\{ discard; \\}\\s+return${wgsl ? " fragmentOutputs" : ""};`).exec(fragment);
    expect(prePass).not.toBeNull();
    const written = Math.max(-1, ...[...fragment.matchAll(wgsl ? /fragmentOutputs\.color\s*=/g : /gl_FragColor\s*=/g)].map((match) => match.index));
    expect(written).toBeGreaterThan(-1);
    expect(fragment.lastIndexOf(`if (${prePass![1]}) { discard; }`)).toBeGreaterThan(written);
    // Only a graph with Water Waves has a GPU path, so only it carries the blend cull.
    expect(vertex).not.toContain(wgsl ? "vertexOutputs.position.z" : "gl_Position.z");
  });

  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("culls a blending GPU-path surface's deep vertices and reads the geometry's waterline with Water Waves in language %s", async (language) => {
    const wgsl = language === ShaderLanguage.WGSL, result = compile(host(wgsl), allNodes());
    expect(await result.ready).toEqual([]);
    const { vertex, fragment } = stages((await waterVariantOf(result)).compiledShaders), clip = wgsl ? "vertexOutputs.position" : "gl_Position";
    const cull = vertex.lastIndexOf(`${clip}.z = 2.0 * ${clip}.w;`);
    expect(cull).toBeGreaterThan(vertex.lastIndexOf(`${clip} =`));
    expect(vertex.slice(0, cull)).toMatch(/#if defined\(SLATE_WATER_GPU_WAVES\) && defined\(SLATE_WATER_BLEND\)\s+if \(min\([^#]*\)\) \{\s+$/);
    // Water Foam reads the per-pixel height; the cut reads the vertex stage's, as built-in water's waterline does.
    const heights = [...fragment.matchAll(/#ifdef SLATE_WATER_GPU_WAVES\s+swnHeight = ([\w.]+);/g)].map((match) => match[1]!.replace(/^fragmentInputs\./, ""));
    expect(heights.some((name) => new RegExp(`\\b${name} = `).test(vertex))).toBe(true);
    // The depth pre-pass samples none of the waves' per-pixel spectrum.
    expect(fragment).toMatch(/#ifndef DEPTHPREPASS\s+#ifdef SLATE_WATER_GPU_WAVES/);
  });

  it("compiles the depth pre-pass as its own variant, for water only", async () => {
    const scene = host(), result = compile(scene, allNodes());
    expect(await result.ready).toEqual([]);
    const water = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    const box = MeshBuilder.CreateBox("box", {}, scene);
    box.material = result.material;
    updateSceneWater(scene);
    const drawn = water.material as NodeMaterial;
    expect(drawn).not.toBe(result.material);
    const engine = scene.getEngine(), colour = engine.currentRenderPassId, prePass = engine.createRenderPassId("pre-pass");
    expect(await definesFor(drawn, water)).not.toContain("#define DEPTHPREPASS");
    engine.currentRenderPassId = prePass;
    engine.setColorWrite(false);
    try {
      expect(await definesFor(drawn, water)).toContain("#define DEPTHPREPASS");
      expect(await definesFor(result.material, box)).not.toContain("#define DEPTHPREPASS");
    } finally {
      engine.setColorWrite(true);
      engine.currentRenderPassId = colour;
      engine.releaseRenderPassId(prePass);
    }
  });

  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("writes no normal or reflectivity in the scene effects' geometry pass, after the output's, in language %s", async (language) => {
    const wgsl = language === ShaderLanguage.WGSL, result = compile(host(wgsl), createDefaultMaterialDocument("Plain"));
    expect(await result.ready).toEqual([]);
    const { fragment } = stages((await waterVariantOf(result)).compiledShaders), target = wgsl ? "fragmentOutputs.fragData0" : "gl_FragData[0]";
    const exempt = fragment.lastIndexOf("#ifdef SLATE_WATER_EFFECTS_GEOMETRY");
    expect(exempt).toBeGreaterThan(fragment.lastIndexOf("* 0.5 + 0.5, 1.0);"));
    const after = fragment.slice(exempt);
    expect(after).toContain(`PREPASS_WORLD_NORMAL_INDEX == 0\n${target} = ${wgsl ? "vec4f" : "vec4"}(0.5, 0.5, 0.5, 1.0);`);
    expect(after).toContain(`PREPASS_REFLECTIVITY_INDEX == 0\n${target} = ${wgsl ? "vec4f" : "vec4"}(0.0, 0.0, 0.0, 1.0);`);
  });

  it("compiles the scene effects' geometry pass as its own variant, for water only", async () => {
    const scene = host(), result = compile(scene, createDefaultMaterialDocument("Plain"));
    expect(await result.ready).toEqual([]);
    const water = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    const box = MeshBuilder.CreateBox("box", {}, scene);
    box.material = result.material;
    const drawn = water.material as NodeMaterial;
    const engine = scene.getEngine(), colour = engine.currentRenderPassId;
    const spatial = engine.createRenderPassId("Spatial Geometry"), authored = engine.createRenderPassId("Post-process Geometry");
    registerSpatialGeometryPass(scene, spatial);
    try {
      expect(await definesFor(drawn, water)).not.toContain("SLATE_WATER_EFFECTS_GEOMETRY");
      engine.currentRenderPassId = spatial;
      expect(await definesFor(drawn, water)).toContain("#define SLATE_WATER_EFFECTS_GEOMETRY\n");
      expect(await definesFor(result.material, box)).not.toContain("SLATE_WATER_EFFECTS_GEOMETRY");
      // An authored post-process chain's geometry pass keeps the water's own surface, as it does built-in water's.
      engine.currentRenderPassId = authored;
      expect(await definesFor(drawn, water)).not.toContain("SLATE_WATER_EFFECTS_GEOMETRY");
    } finally {
      engine.currentRenderPassId = colour;
      unregisterSpatialGeometryPass(scene, spatial);
      engine.releaseRenderPassId(spatial);
      engine.releaseRenderPassId(authored);
    }
  });

  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("raises a translucent Material's coverage for its brightest light before the fog, off in Scene Linear, in language %s", async (language) => {
    const wgsl = language === ShaderLanguage.WGSL;
    const translucent = createDefaultMaterialDocument("Glass");
    translucent.blendMode = "translucent";
    const result = compile(host(wgsl), translucent);
    expect(await result.ready).toEqual([]);
    expect(result.material.compiledShaders).not.toContain("swnBright");
    const { fragment } = stages((await waterVariantOf(result)).compiledShaders);
    const raise = fragment.indexOf("swnBright");
    expect(raise).toBeGreaterThan(-1);
    expect(fragment.slice(0, raise)).toMatch(/#if defined\(SLATE_WATER_SURFACE\) && !defined\(IMAGEPROCESSINGPOSTPROCESS\)\s+\{\s+(float |var )$/);
    // The Scene Fog block mixes what the raise leaves.
    expect(fragment.lastIndexOf("= sceneFogKeep(")).toBeGreaterThan(raise);
    // An opaque Material covers everything already.
    const opaque = compile(host(wgsl), createDefaultMaterialDocument("Stone"));
    expect(await opaque.ready).toEqual([]);
    expect((await waterVariantOf(opaque)).compiledShaders).not.toContain("swnBright");
  });

  it("binds each water mesh's nearest removal volumes, clears the empty slots and binds nothing off water", async () => {
    const scene = host(), result = compile(scene, createDefaultMaterialDocument("Plain"));
    expect(await result.ready).toEqual([]);
    const body = normalizeWaterBody({ width: 10, length: 10, resolution: 8 });
    const near = createWaterMesh(scene, "near", body, createDefaultWaterDefinition(), result.material);
    const far = createWaterMesh(scene, "far", body, createDefaultWaterDefinition(), result.material);
    far.position.x = 100;
    const box = MeshBuilder.CreateBox("box", {}, scene);
    box.material = result.material;
    const hole = createWaterRemovalMesh(scene, "hole", { shape: "sphere", width: 2 }, { editor: false });
    hole.position.set(2, 0, 1);
    updateSceneWater(scene);
    const drawn = near.material as NodeMaterial;
    expect(far.material).toBe(drawn);
    const effect = await programFor(drawn, near);
    expect(await programFor(drawn, far)).toBe(effect);
    const vectors = new Map<string, number[]>(), matrices = new Map<string, Matrix>();
    for (const program of [effect, await programFor(result.material, box)]) {
      vi.spyOn(program, "setFloat4").mockImplementation((name, x, y, z, w) => { vectors.set(name, [x, y, z, w]); return program; });
      vi.spyOn(program, "setMatrix").mockImplementation((name, matrix) => { matrices.set(name, matrix as Matrix); return program; });
    }
    const bind = (mesh: AbstractMesh) => {
      vectors.clear(); matrices.clear();
      (mesh.material as NodeMaterial).bindForSubMesh(mesh.computeWorldMatrix(true), mesh as Mesh, mesh.subMeshes[0]!);
    };
    bind(near);
    // A sphere 2 wide: shape code 2, then the half extents.
    expect(vectors.get("slateWaterRemovalShape0")).toEqual([2, 1, 2, 2]);
    expect(matrices.get("slateWaterRemoval0")!.getTranslation().asArray()).toEqual([-2, 0, -1]);
    for (let i = 1; i < 4; i++) expect(vectors.get(`slateWaterRemovalShape${i}`), `slot ${i}`).toEqual([0, 0, 0, 0]);
    bind(far);
    expect(vectors.get("slateWaterRemovalShape0")).toEqual([0, 0, 0, 0]);
    bind(box);
    expect([...vectors.keys(), ...matrices.keys()].filter((name) => name.startsWith("slateWater"))).toEqual([]);
  });
});

describe("Water variant", () => {
  const compiledEffects = (scene: Scene) => Object.keys((scene.getEngine() as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects).length;
  /** The default Material with a live Specular parameter. */
  const shiny = () => {
    const doc = createDefaultMaterialDocument("Shiny");
    const output = doc.nodes.find((node) => node.type === "output.surface")!;
    doc.nodes.push({ id: "shine", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Shine", value: [0.3] } });
    doc.edges.push({ id: "shine-output", sourceNodeId: "shine", sourcePinId: "out", targetNodeId: output.id, targetPinId: "specular" });
    return doc;
  };

  it("draws a Material's water variant on water and the base elsewhere, and one parameter edit reaches both", async () => {
    const scene = host(), result = compile(scene, shiny());
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    const box = MeshBuilder.CreateBox("box", {}, scene);
    box.material = result.material;
    updateSceneWater(scene);
    const drawn = lake.material as NodeMaterial;
    expect(box.material).toBe(result.material);
    expect(drawn).not.toBe(result.material);
    expect(waterVariantBase(drawn)).toBe(result.material);
    // The base has no water block, uniform or define; its water variant has the cut.
    expect(result.material.attachedBlocks.some((block) => block instanceof WaterCutBlock || block instanceof WaterCoverageBlock)).toBe(false);
    expect(drawn.attachedBlocks.some((block) => block instanceof WaterCutBlock)).toBe(true);
    const base = await programFor(result.material, box);
    expect(base.defines).not.toMatch(/SLATE_WATER/);
    expect(base.getUniformNames().filter((name) => name.startsWith("slateWater"))).toEqual([]);
    expect((await programFor(drawn, lake)).getUniformNames()).toContain("slateWaterRemoval0");
    expect(result.setParameter("Shine", { kind: "float", value: 0.7 })).toBe(true);
    expect(result.material.getBlockByName("shine")).toHaveProperty("value", 0.7);
    expect(drawn.getBlockByName("shine")).toHaveProperty("value", 0.7);
  });

  it("follows a library rebind to the next generation's warmed water variant, and goes with the Material", async () => {
    const f = { scene: host() };
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(f.scene, "water", shiny());
    if (!first.ok) throw new Error("Expected a compiled material");
    expect(await first.ready).toEqual([]);
    const lake = createWaterMesh(f.scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), first.material);
    const box = MeshBuilder.CreateBox("box", {}, f.scene);
    box.material = first.material;
    updateSceneWater(f.scene);
    await programFor(lake.material as NodeMaterial, lake);
    const before = lake.material!;
    // An edit that changes the program: the next generation compiles for the water mesh before it moves to it.
    const edited = shiny();
    edited.nodes[0]!.properties = { value: [0.2, 0.4, 0.8, 1] };
    const next = library.acquire(f.scene, "water", edited);
    if (!next.ok) throw new Error("Expected the replacement material");
    expect(await next.ready).toEqual([]);
    expect(box.material).toBe(next.material);
    const after = lake.material as NodeMaterial;
    expect(after).not.toBe(before);
    expect(waterVariantBase(after)).toBe(next.material);
    expect(f.scene.materials).not.toContain(before);
    const effects = compiledEffects(f.scene);
    expect(after.isReadyForSubMesh(lake, lake.subMeshes[0]!)).toBe(true);
    expect(compiledEffects(f.scene)).toBe(effects);
    // The water mesh's disposal releases the variant; the library's release disposes the base.
    lake.dispose();
    await Promise.resolve();
    expect(f.scene.materials).not.toContain(after);
    library.release(f.scene, "water"); library.release(f.scene, "water");
    expect(f.scene.materials).not.toContain(next.material);
  });

  it("is disposed with its base while a water mesh still holds it", async () => {
    const scene = host(), result = compile(scene, shiny());
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    const drawn = lake.material!;
    expect(scene.materials).toContain(drawn);
    result.dispose();
    expect(scene.materials).not.toContain(drawn);
  });

  it("keeps the cut in a water mesh's outline and capture variants, not in the base's", async () => {
    const scene = host(), result = compile(scene, createDefaultMaterialDocument("Plain"));
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    for (const kind of ["outlineMask", "captureDepth", "captureNormal"] as const) {
      const water = acquireAuthoredMaterialVariant(lake.material!, kind)!, plain = acquireAuthoredMaterialVariant(result.material, kind)!;
      disposers.push(() => { void water.release(); void plain.release(); });
      expect(await water.compiled.ready).toEqual([]);
      expect(await plain.compiled.ready).toEqual([]);
      expect(water.compiled.material.attachedBlocks.some((block) => block instanceof WaterCutBlock), kind).toBe(true);
      expect(plain.compiled.material.attachedBlocks.some((block) => block instanceof WaterCutBlock), kind).toBe(false);
    }
  });
});

describe("Water ownership", () => {
  /** FT_World's sea and Ocean, drawn with the water starter's water variant. */
  const sea = (scene: Scene) => {
    const material = builtInWaterMaterial(scene);
    const global = createWaterMesh(scene, "global", normalizeWaterBody({}, "global"), undefined, material);
    global.position.set(0, -6, 0);
    const ocean = createWaterMesh(scene, "ocean", normalizeWaterBody({ width: 40, length: 80 }, "ocean"), undefined, material);
    ocean.position.set(36, -6, 0);
    updateSceneWater(scene);
    updateSceneWater(scene);
    return { global, ocean };
  };

  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("cuts a Global Water and an Ocean along their seam per pixel, a river and its lake per vertex, in language %s", async (language) => {
    const scene = host(language === ShaderLanguage.WGSL);
    overlook(scene);
    const { global, ocean } = sea(scene);
    for (const mesh of [global, ocean]) {
      const effect = await programFor(mesh.material as NodeMaterial, mesh);
      expect(effect.defines, mesh.name).toMatch(/^#define SLATE_WATER_OWNERSHIP$/m);
      expect(effect.fragmentSourceCode, mesh.name).toContain("swOwnership(");
    }
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 30, length: 20 }, "lake"), undefined, builtInWaterMaterial(scene));
    lake.position.set(-60, 0, 0);
    const river = createWaterMesh(scene, "river", normalizeWaterBody({ width: 6, points: [[-40, 0, 0], [-12, 0, 0]] }, "river"), undefined, builtInWaterMaterial(scene));
    river.position.set(-60, 0, 0);
    updateSceneWater(scene);
    updateSceneWater(scene);
    for (const mesh of [lake, river]) {
      const defines = await definesFor(mesh.material as NodeMaterial, mesh);
      expect(defines, mesh.name).toMatch(/^#define SLATE_WATER_BLEND$/m);
      expect(defines, mesh.name).not.toMatch(/^#define SLATE_WATER_OWNERSHIP$/m);
    }
  });

  it("compiles nothing as the camera moves the graded grids and recentres Global Water", async () => {
    const scene = host();
    overlook(scene);
    const { global, ocean } = sea(scene);
    const before = [await programFor(global.material as NodeMaterial, global), await programFor(ocean.material as NodeMaterial, ocean)];
    const compiled = (scene.getEngine() as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects;
    const programs = Object.keys(compiled).length;
    const camera = scene.activeCamera as FreeCamera;
    const centres = new Set<string>();
    // Across the Ocean's dense region (it regrades), past Global Water's cells (it recentres), near and far.
    for (const [x, y, z] of [[-4, 52, -82], [20, 30, -20], [36, 10, 0], [60, 20, 30], [0, 150, -250], [-200, 400, -900], [-4, 52, -82]] as const) {
      camera.position.set(x, y, z);
      camera.setTarget(new Vector3(4, -6, 6));
      scene.incrementRenderId();
      updateSceneWater(scene);
      const offset = waterGridOffset(global);
      centres.add(`${offset[0]},${offset[2]}`);
      for (const mesh of [global, ocean]) expect(mesh.material!.isReadyForSubMesh(mesh, mesh.subMeshes[0]!), mesh.name).toBe(true);
    }
    // Global Water recentred along the way (its grid offset moved), and no program was compiled: a regraded Ocean's new
    // vertex buffers re-prepare its defines, which find the same program in the Engine's cache.
    expect(centres.size).toBeGreaterThan(3);
    expect(Object.keys(compiled).length).toBe(programs);
    expect([global.subMeshes[0]!.effect, ocean.subMeshes[0]!.effect]).toEqual(before);
  });
});

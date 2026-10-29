import { afterEach, describe, expect, it, vi } from "vitest";
import { Color3, FreeCamera, Matrix, MeshBuilder, Vector3, NullEngine, Scene, ShaderLanguage, type AbstractMesh, type Mesh, type NodeMaterial } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeRenderingQuality, normalizeWaterBody } from "@haptic/core";
import { createDefaultMaterialDocument, createWaterMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { updateSceneRenderingSettings } from "./render-settings";
import { createWaterMesh, sceneWaterSamplesSceneCopy, updateSceneWater, waterMeshReflectsObjects, waterMeshSamplesSceneCopy } from "./water-mesh";
import { materialSceneCopyUse, meshWaterNodeSurface } from "./water-node-blocks";
import { createWaterRemovalMesh } from "./water-removal-mesh";
import { registerSpatialGeometryPass, unregisterSpatialGeometryPass } from "./spatial-geometry-passes";

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
      expect(fragment).toContain("swCopyTexel");
      // Its lighting takes Water Reflection's normal: the half vector toward the reflected ray, lifted above the horizon
      // as built-in water lifts it, from the waves' normal flattened by the horizon haze through the scene's fog.
      expect(fragment).toMatch(/\w+ = swnH;/);
      expect(fragment).toMatch(/swnRLiftA(: f32)? = 60\.0 \* \(0\.03 - swnR\.y\)/);
      // Its Roughness is built-in water's slope-variance roughness, which drops away under the haze.
      expect(fragment).toMatch(/\w+ = swnShade;/);
      expect(fragment).toMatch(/swnShadeVar(: f32)? = \(max\([^;]*\* \(1\.0 - 0\.97 \* swHaze\);/);
      expect(fragment).toMatch(/swnAirKeep = max\(toLinearSpace\(CalcFogFactor\(/);
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

  it("mix Water Colors toward a differently coloured neighbour where the bodies blend", async () => {
    const scene = host(), own = createDefaultWaterDefinition(), red = { ...own, shallowColor: [1, 0.2, 0.2] as [number, number, number] };
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    new FreeCamera("camera", new Vector3(0, 30, -40), scene);
    const result = compile(scene, graph(["waterWaves", "waterColors"], [["waterWaves", "offset", "worldPositionOffset"], ["waterColors", "shallowColor", "baseColor"]]));
    expect(await result.ready).toEqual([]);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 24, length: 24, resolution: 16 }), own, result.material);
    const neighbour = createWaterMesh(scene, "neighbour", normalizeWaterBody({ width: 24, length: 24, resolution: 16 }), red);
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
    await definesFor(result.material, lake);
    result.material.freeze();
    const dirty = vi.spyOn(result.material, "markDirty");
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

describe("Water Cut", () => {
  const stages = (source: string) => { const [vertex = "", fragment = ""] = source.split("// Fragment shader"); return { vertex, fragment }; };

  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("is in every Surface Material, under the water define, and discards removed water last in language %s", async (language) => {
    const wgsl = language === ShaderLanguage.WGSL, result = compile(host(wgsl), createDefaultMaterialDocument("Plain"));
    expect(await result.ready).toEqual([]);
    const source = result.material.compiledShaders, { vertex, fragment } = stages(source);
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
    const { vertex, fragment } = stages(result.material.compiledShaders), clip = wgsl ? "vertexOutputs.position" : "gl_Position";
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
    const engine = scene.getEngine(), colour = engine.currentRenderPassId, prePass = engine.createRenderPassId("pre-pass");
    expect(await definesFor(result.material, water)).not.toContain("#define DEPTHPREPASS");
    engine.currentRenderPassId = prePass;
    engine.setColorWrite(false);
    try {
      expect(await definesFor(result.material, water)).toContain("#define DEPTHPREPASS");
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
    const { fragment } = stages(result.material.compiledShaders), target = wgsl ? "fragmentOutputs.fragData0" : "gl_FragData[0]";
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
    const engine = scene.getEngine(), colour = engine.currentRenderPassId;
    const spatial = engine.createRenderPassId("Spatial Geometry"), authored = engine.createRenderPassId("Post-process Geometry");
    registerSpatialGeometryPass(scene, spatial);
    try {
      expect(await definesFor(result.material, water)).not.toContain("SLATE_WATER_EFFECTS_GEOMETRY");
      engine.currentRenderPassId = spatial;
      expect(await definesFor(result.material, water)).toContain("#define SLATE_WATER_EFFECTS_GEOMETRY\n");
      expect(await definesFor(result.material, box)).not.toContain("SLATE_WATER_EFFECTS_GEOMETRY");
      // An authored post-process chain's geometry pass keeps the water's own surface, as it does built-in water's.
      engine.currentRenderPassId = authored;
      expect(await definesFor(result.material, water)).not.toContain("SLATE_WATER_EFFECTS_GEOMETRY");
    } finally {
      engine.currentRenderPassId = colour;
      unregisterSpatialGeometryPass(scene, spatial);
      engine.releaseRenderPassId(spatial);
      engine.releaseRenderPassId(authored);
    }
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
    const effect = await programFor(result.material, near);
    expect(await programFor(result.material, far)).toBe(effect);
    const vectors = new Map<string, number[]>(), matrices = new Map<string, Matrix>();
    for (const program of [effect, await programFor(result.material, box)]) {
      vi.spyOn(program, "setFloat4").mockImplementation((name, x, y, z, w) => { vectors.set(name, [x, y, z, w]); return program; });
      vi.spyOn(program, "setMatrix").mockImplementation((name, matrix) => { matrices.set(name, matrix as Matrix); return program; });
    }
    const bind = (mesh: AbstractMesh) => {
      vectors.clear(); matrices.clear();
      result.material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh as Mesh, mesh.subMeshes[0]!);
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

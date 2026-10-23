import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera, Matrix, MeshBuilder, NullEngine, Scene, ShaderLanguage, Vector3, type AbstractMesh, type NodeMaterial } from "@babylonjs/core";
import {
  createDefaultWaterDefinition, createWaterWaveOutput, normalizeWaterBody, RENDER_QUALITY_PROFILES, WATER_FFT_CASCADES_MAX, waterBankGain,
  waterEulerianGradient, waterSpectrum,
} from "@haptic/core";
import { createDefaultMaterialDocument, lowerMaterialDocument, type MaterialDocument } from "@haptic/shader-graph";
import { acquireAuthoredMaterialVariant, compileMaterialPlan } from "./material-compiler";
import { updateSceneRenderingSettings } from "./render-settings";
import { waterFftCycle, waterFftSynthesize, waterSpectrumInitial, waterSpectrumLayout } from "./water-fft-spectrum";
import { WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM, WATER_NODE_FOAM_UNIFORM, WATER_VERTEX_WAVE_UNIFORMS, waterWaveBlockSource } from "./water-material";
import { createWaterMesh, setSceneWaterTime, updateSceneWater } from "./water-mesh";
import { materialHasWaterWaves } from "./water-waves-block";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.restoreAllMocks(); });

function host(webgpu = false): Scene {
  const engine = new NullEngine(), scene = new Scene(engine);
  if (webgpu) vi.spyOn(engine, "isWebGPU", "get").mockReturnValue(true);
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  return scene;
}

/** A Surface graph that applies the node: Offset into World Position Offset, Normal into Normal, the rest into scalar channels. */
function wavesDocument(withSurface = false): MaterialDocument {
  const doc = createDefaultMaterialDocument("Waves");
  doc.nodes.push({ id: "waves", type: "input.waterWaves", position: { x: 0, y: 0 }, properties: {} });
  const wire = (source: string, pin: string, target: string) =>
    doc.edges.push({ id: `${source}-${pin}-${target}`, sourceNodeId: source, sourcePinId: pin, targetNodeId: "output", targetPinId: target });
  wire("waves", "offset", "worldPositionOffset");
  wire("waves", "normal", "normal");
  wire("waves", "height", "roughness");
  wire("waves", "crestFoam", "emissive");
  if (!withSurface) { wire("waves", "time", "metallic"); return doc; }
  doc.nodes.push({ id: "surface", type: "input.waterSurface", position: { x: 0, y: 0 }, properties: {} });
  wire("surface", "waveHeight", "metallic");
  wire("surface", "time", "opacity");
  return doc;
}

function compile(scene: Scene, doc: MaterialDocument) {
  const plan = lowerMaterialDocument(doc);
  if (!plan.ok) throw new Error(JSON.stringify(plan.diagnostics));
  const result = compileMaterialPlan(plan.plan, { scene, name: "waves" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  disposers.push(result.dispose);
  return result;
}

/** Compiles `material` for `mesh` and returns the program its first sub-mesh draws with. */
async function programFor(material: NodeMaterial, mesh: AbstractMesh) {
  await material.forceCompilationAsync(mesh);
  expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
  return mesh.subMeshes[0]!.effect!;
}

/** Whether `line` is declared in the `#ifdef define` block of generated shader text. */
/** Whether `line` sits in an `#ifdef define` block, or an `#if condition` block when `define` is a condition. */
function declaredUnder(source: string, define: string, line: string): boolean {
  return [...source.matchAll(/#if(?:def)? ([^\n]+)\n([\s\S]*?)#endif/g)].some((block) => block[1] === define && block[2]!.includes(line));
}

describe("Water Waves node", () => {
  it.each([ShaderLanguage.GLSL, ShaderLanguage.WGSL])("declares its inputs once per stage, displaces in the vertex stage and shades per pixel in language %s", async (language) => {
    const wgsl = language === ShaderLanguage.WGSL, scene = host(wgsl);
    const result = compile(scene, wavesDocument());
    expect(await result.ready).toEqual([]);
    const source = result.material.compiledShaders;
    // The fragment program declares the vertex program's uniforms too, so each is declared once per stage.
    const [vertex = "", fragment = ""] = source.split("// Fragment shader");
    const uniform = (name: string) => wgsl ? `uniform ${name}: vec4f;` : `uniform vec4 ${name};`;
    for (const name of [...WATER_VERTEX_WAVE_UNIFORMS, WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM]) {
      expect(vertex.split(uniform(name)).length - 1, name).toBe(1);
      expect(fragment.split(uniform(name)).length - 1, name).toBe(1);
    }
    expect(fragment.split(uniform(WATER_NODE_FOAM_UNIFORM)).length - 1).toBe(1);
    const attribute = (name: string, components: number) => wgsl ? `attribute ${name}: vec${components}f;` : `attribute vec${components} ${name};`;
    for (const [name, components, define] of [["slateWaterData", 4, "SLATE_WATER_SURFACE"], ["slateWaterBaseNormal", 3, "SLATE_WATER_SURFACE"], ["slateWaterBlend", 4, "defined(SLATE_WATER_BLEND) || defined(SLATE_WATER_NODE_BLEND)"]] as const) {
      expect(declaredUnder(source, define, attribute(name, components)), name).toBe(true);
      expect(source.split(attribute(name, components)).length - 1, name).toBe(1);
    }
    // The spectrum's sampler in both stages, its foam in the fragment only, and no source prefix left unbound.
    expect(vertex).toContain("slateWaterFftSampler");
    expect(vertex).not.toContain("slateWaterFoamSampler");
    expect(fragment).toContain("slateWaterFoamSampler");
    expect(source).not.toMatch(/\b[UAOS]\.slate|\bIN\./);
    expect(source).toContain("#ifdef SLATE_WATER_GPU_WAVES");
    if (wgsl) {
      expect(source).toContain("vertexInputs.slateWaterData.x");
      expect(source).toContain("uniforms.slateWaterFft");
      // Every GLSL declaration was translated.
      expect(source).not.toMatch(/^\s*(float|vec[234]) \w+ =/m);
      expect(source).toMatch(/var swvNormal: vec3f = normalize\(vec3f\(/);
    } else {
      expect(source).toMatch(/vec3 swvNormal = normalize\(vec3\(/);
      expect(source).toMatch(/uniform highp sampler2DArray slateWaterFftSampler;/);
    }
  });

  it("displaces the rest point by the spectrum at Wave Scale, λ and the bank fade, with the surface's normal", () => {
    const water = { ...createDefaultWaterDefinition(), steepness: 0.4 }, spectrum = waterSpectrum(water), size = 16;
    const layout = waterSpectrumLayout(spectrum, size, 1), layers = waterFftSynthesize(waterSpectrumInitial(spectrum, layout), layout, waterFftCycle(3.7, layout.timeScale));
    const patch = layout.patchSizes[0]!, scale = 0.8, lambda = spectrum.choppiness, fade = 6;
    for (const [i, j, bank] of [[3, 5, 30], [11, 2, 30], [7, 13, fade / 2]] as const) {
      // A rest point on texel (i, j)'s centre of the unturned first cascade, a whole patch from the origin.
      const x = (i + size) * patch / size, z = (j - size) * patch / size;
      const shader = shaderSample(layers, size, { scale, lambda, patch, fade }, x, z, patch / size, bank);
      const o = (j * size + i) * 4, a = layers[0]!, b = layers[1]!, gain = new Float64Array(2);
      waterBankGain(bank, fade, gain);
      const label = `texel ${i}, ${j}`;
      expect(shader.height, label).toBeCloseTo(a[o + 1]! * scale, 6);
      expect(shader.position[0], label).toBeCloseTo(x + a[o]! * scale * lambda * gain[0]!, 5);
      expect(shader.position[1], label).toBeCloseTo(a[o + 1]! * scale, 6);
      expect(shader.position[2], label).toBeCloseTo(z + a[o + 2]! * scale * lambda * gain[0]!, 5);
      // FFT-Ocean's normal, J⁻ᵀ∇H of the displaced surface, as core takes it.
      const shear = scale * lambda * gain[0]!, wave = createWaterWaveOutput(), slope = new Float64Array(2);
      wave[5] = 1 + b[o + 2]! * shear; wave[6] = a[o + 3]! * shear; wave[13] = a[o + 3]! * shear; wave[7] = 1 + b[o + 3]! * shear;
      waterEulerianGradient(wave, b[o]! * scale, b[o + 1]! * scale, slope);
      const n = Math.hypot(slope[0]!, 1, slope[1]!);
      expect(shader.normal.map((value) => Number(value.toFixed(5))), label).toEqual([-slope[0]! / n, 1 / n, -slope[1]! / n].map((value) => Number(value.toFixed(5))));
    }
  });

  it("computes the same arithmetic in WGSL as in GLSL", () => {
    const water = createDefaultWaterDefinition(), spectrum = waterSpectrum(water), size = 16;
    const layout = waterSpectrumLayout(spectrum, size, 1), layers = waterFftSynthesize(waterSpectrumInitial(spectrum, layout), layout, waterFftCycle(5.5, layout.timeScale));
    const terms = { scale: 1, lambda: spectrum.choppiness, patch: layout.patchSizes[0]!, fade: 4 };
    const glsl = shaderSample(layers, size, terms, 6.5, -3.5, 0.3, 2);
    // The WGSL text itself, run as it is except for the prefixes the language binds uniforms and attributes with.
    const wgsl = waterWaveBlockSource(ShaderLanguage.WGSL).replace(/\b(?:uniforms|vertexInputs)\./g, "");
    expect(wgsl).toContain("var swvH: f32 = 0.0;");
    expect(shaderSample(layers, size, terms, 6.5, -3.5, 0.3, 2, [0, 1, 0], wgsl)).toEqual(glsl);
  });

  it("compiles out for meshes that are not water displaced by the node", async () => {
    const scene = host(), result = compile(scene, wavesDocument());
    expect(await result.ready).toEqual([]);
    const ordinary = MeshBuilder.CreateGround("ordinary", {}, scene);
    ordinary.material = result.material;
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ resolution: 8 }), createDefaultWaterDefinition(), result.material);
    const [ordinaryDefines, lakeDefines] = [(await programFor(result.material, ordinary)).defines as string, (await programFor(result.material, lake)).defines as string];
    expect(ordinaryDefines).not.toContain("SLATE_WATER_GPU_WAVES");
    expect(ordinaryDefines).not.toContain("SLATE_WATER_SURFACE");
    expect(lakeDefines).toMatch(/^#define SLATE_WATER_GPU_WAVES$/m);
    expect(lakeDefines).toMatch(/^#define SLATE_WATER_SURFACE$/m);
    expect(lakeDefines).not.toContain("SLATE_WATER_BLEND");
  });

  it("is found in a built material, and only there", () => {
    const scene = host();
    expect(materialHasWaterWaves(compile(scene, wavesDocument()).material)).toBe(true);
    expect(materialHasWaterWaves(compile(scene, createDefaultMaterialDocument("Plain")).material)).toBe(false);
    expect(materialHasWaterWaves(null)).toBe(false);
  });

  it.each(["shadowDepth", "captureDepth", "captureNormal", "outlineMask"] as const)("builds the %s variant with the same node, so its program displaces like the colour pass", async (kind) => {
    const scene = host(), result = compile(scene, wavesDocument());
    expect(await result.ready).toEqual([]);
    const variant = acquireAuthoredMaterialVariant(result.material, kind)!;
    try {
      expect(await variant.compiled.ready).toEqual([]);
      expect(materialHasWaterWaves(variant.compiled.material)).toBe(true);
      const source = variant.compiled.material.compiledShaders;
      expect(source).toContain("slateWaterFftCascade0");
      expect(source).toMatch(/swvD = swvD \* swvGain;/);
    } finally { await variant.release(); }
  });

  it("changes nothing for graphs without the node: Water Surface keeps its declarations and vertex data", async () => {
    const scene = host(), doc = createDefaultMaterialDocument("Foam");
    doc.nodes.push({ id: "surface", type: "input.waterSurface", position: { x: 0, y: 0 }, properties: {} });
    doc.edges.push({ id: "foam", sourceNodeId: "surface", sourcePinId: "bankDistance", targetNodeId: "output", targetPinId: "roughness" });
    const result = compile(scene, doc);
    expect(await result.ready).toEqual([]);
    const source = result.material.compiledShaders;
    expect(declaredUnder(source, "SLATE_WATER_SURFACE", "attribute vec4 slateWaterData;")).toBe(true);
    expect(declaredUnder(source, "SLATE_WATER_SURFACE", "attribute vec3 slateWaterFlow;")).toBe(true);
    expect(source).not.toMatch(/SLATE_WATER_GPU_WAVES|slateWaterClock|slateWaterBaseNormal/);
    expect(source).toMatch(/\w+ = slateWaterData\.x;/);
  });

  it("gives Water Surface the node's Wave Height and Simulation Time, because a GPU mesh's vertex data carries neither", async () => {
    const scene = host(), result = compile(scene, wavesDocument(true));
    expect(await result.ready).toEqual([]);
    const source = result.material.compiledShaders;
    const height = /(\w+) = swvH;/.exec(source)?.[1], time = /(\w+) = slateWaterClock\.x;/.exec(source)?.[1];
    expect(height).toBeDefined();
    expect(time).toBeDefined();
    const gpu = [...source.matchAll(/#ifdef SLATE_WATER_GPU_WAVES\s+(\w+) = (\w+);\s+#endif/g)].map((match) => match[2]);
    expect(gpu).toEqual(expect.arrayContaining([height, time]));
    // The vertex data stays the source for every other mesh: the node's values are added under the define, not instead.
    expect(source.match(/\b\w+ = slateWaterData\.w;/g)).toHaveLength(1);
  });

  it("binds each draw's own grid offset and the water clock when meshes share a frozen material", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    new FreeCamera("camera", new Vector3(40, 6, -25), scene);
    updateSceneRenderingSettings(scene, { water: { blendDistance: 0 } });
    setSceneWaterTime(scene, 2);
    const result = compile(scene, wavesDocument());
    expect(await result.ready).toEqual([]);
    const global = (name: string) => createWaterMesh(scene, name, normalizeWaterBody({}, "global"), createDefaultWaterDefinition(), result.material);
    const a = global("a"), b = global("b");
    // Uniform scaling keeps one program for both (Babylon compiles NONUNIFORMSCALING separately).
    b.position.set(100, 0, -30); b.rotation.y = Math.PI / 2; b.scaling.set(2, 2, 2);
    updateSceneWater(scene);
    const effect = await programFor(result.material, a);
    expect(await programFor(result.material, b)).toBe(effect);
    result.material.freeze();
    const bound = new Map<string, number[]>();
    vi.spyOn(effect, "setFloat4").mockImplementation((name, x, y, z, w) => { bound.set(name, [x, y, z, w]); return effect; });
    const bind = (mesh: typeof a) => { result.material.bindForSubMesh(mesh.computeWorldMatrix(true), mesh, mesh.subMeshes[0]!); return [...bound.get("slateWaterGridOffset")!]; };
    // The snapped centre is the camera within one cell; each volume's offset is the camera relative to it, in world space.
    const cell = Math.min(3, Math.max(0.2, createDefaultWaterDefinition().waveLength / 20)) / RENDER_QUALITY_PROFILES.medium.water.meshDensity;
    const offsetA = bind(a), offsetB = bind(b);
    for (const [i, expected] of [40, 0, -25].entries()) expect(Math.abs(offsetA[i]! - expected)).toBeLessThanOrEqual(cell);
    for (const [i, expected] of [-60, 0, 5].entries()) expect(Math.abs(offsetB[i]! - expected)).toBeLessThanOrEqual(cell);
    expect(bound.get("slateWaterClock")).toEqual([2, 0, 0, 0]);
  });
});

/**
 * The vertex shader's result for one vertex: runs `waterWaveBlockSource` (or `source`) with one cascade over CPU-synthesized
 * spectrum `layers` (`size`-grids, sampled bilinearly with wrapping, as the GPU's repeating texture is), the spectrum's
 * uniforms (Wave Scale, λ, its patch, no floating origin) and bank fade, a rest grid of the given `spacing`, `bank`
 * distance and `baseNormal`, and the rest point (x, 0, z), the eye overhead.
 */
function shaderSample(
  layers: Float64Array[], size: number, terms: { scale: number; lambda: number; patch: number; fade: number }, x: number, z: number, spacing: number, bank: number,
  baseNormal: number[] = [0, 1, 0], source = waterWaveBlockSource(ShaderLanguage.GLSL),
) {
  const variables = new Map<string, Value>();
  variables.set("slateWaterGridOffset", [0, 0, 0, 0]);
  variables.set("slateWaterSwellInfo", [terms.fade, 0, 0, 0]);
  variables.set("slateWaterFft", [terms.scale, terms.lambda, size, 7.13]);
  variables.set("slateWaterFftCascade0", [1 / terms.patch, 0.5 / size, 0.5 / size, 0]);
  for (let c = 1; c < WATER_FFT_CASCADES_MAX; c++) variables.set(`slateWaterFftCascade${c}`, [0, 0, 0, 0]);
  variables.set("slateWaterEye", [x, 10, z, 0]);
  variables.set("slateWaterData", [spacing, bank, 5, 0]);
  variables.set("slateWaterBaseNormal", baseNormal);
  variables.set("worldPos", [x, 0, z, 1]);
  const tap = (uv: Value, layer: Value) => {
    const [u, v] = lanes(uv) as [number, number], grid = layers[lanes(layer)[0]!]!;
    const fx = u * size - 0.5, fy = v * size - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (ix: number, iy: number, channel: number) => grid[((((iy % size) + size) % size) * size + (((ix % size) + size) % size)) * 4 + channel]!;
    return [0, 1, 2, 3].map((c) => (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) + (at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx) * ty);
  };
  evaluateShader(source, variables, { SLATE_WATER_GPU_WAVES: 1, SLATE_WATER_FFT: 1 }, { swFftTapLod: tap });
  return { position: variables.get("worldPos") as number[], height: variables.get("swvH") as number, normal: variables.get("swvNormal") as number[] };
}

type Value = number | number[];
const lanes = (value: Value): number[] => (typeof value === "number" ? [value] : value);
const each = (value: Value, f: (x: number) => number): Value => (typeof value === "number" ? f(value) : value.map(f));
/** Component-wise `f`, a scalar broadcast against a vector. */
function combine(a: Value, b: Value, f: (x: number, y: number) => number): Value {
  if (typeof a === "number" && typeof b === "number") return f(a, b);
  const x = lanes(a), y = lanes(b), n = Math.max(x.length, y.length);
  return Array.from({ length: n }, (_, i) => f(x[x.length === 1 ? 0 : i]!, y[y.length === 1 ? 0 : i]!));
}
const FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  sin: (x: Value) => each(x, Math.sin), cos: (x: Value) => each(x, Math.cos), exp: (x: Value) => each(x, Math.exp), sqrt: (x: Value) => each(x, Math.sqrt),
  clamp: (x: Value, low: Value, high: Value) => combine(combine(x, low, Math.max), high, Math.min),
  mix: (a: Value, b: Value, t: Value) => combine(combine(a, combine(1, t, (one, k) => one - k), (p, q) => p * q), combine(b, t, (p, q) => p * q), (p, q) => p + q),
  dot: (a: Value, b: Value) => lanes(combine(a, b, (x, y) => x * y)).reduce((sum, x) => sum + x, 0),
  max: (a: Value, b: Value) => combine(a, b, Math.max), min: (a: Value, b: Value) => combine(a, b, Math.min),
  step: (edge: Value, x: Value) => combine(edge, x, (e, v) => (v < e ? 0 : 1)),
  normalize: (v: Value) => { const length = Math.hypot(...lanes(v)); return each(v, (x) => x / length); },
  abs: (x: Value) => each(x, Math.abs), log2: (x: Value) => each(x, Math.log2),
  length: (v: Value) => Math.hypot(...lanes(v)),
};

/**
 * Runs the shader subset the water vertex source is written in, GLSL or its WGSL translation (declarations and assignments
 * of float and vec2-4, arithmetic, swizzles, constructors, a few builtins, `#ifdef` / `#if X >= n`), over `variables`, which
 * it updates. An identifier or function it does not know is an error, so a typo in the shader fails here.
 */
function evaluateShader(source: string, variables: Map<string, Value>, defines: Record<string, number>, extra: Record<string, (...args: Value[]) => Value> = {}): void {
  const lines: string[] = [], branches: boolean[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    const ifdef = /^#ifdef (\w+)$/.exec(line), ifndef = /^#ifndef (\w+)$/.exec(line), ifAtLeast = /^#if (\w+) >= (\d+)$/.exec(line);
    if (ifdef) branches.push(defines[ifdef[1]!] !== undefined);
    else if (ifndef) branches.push(defines[ifndef[1]!] === undefined);
    else if (ifAtLeast) branches.push((defines[ifAtLeast[1]!] ?? 0) >= Number(ifAtLeast[2]));
    else if (line === "#else") branches.push(!branches.pop());
    else if (line === "#endif") branches.pop();
    else if (line.startsWith("#")) throw new Error(`Unsupported directive ${line}`);
    else if (line && branches.every(Boolean)) lines.push(line);
  }
  const text = lines.join(" "), tokens = text.match(/\d+\.\d+|\d+|[A-Za-z_]\w*|\+=|-=|\*=|\/=|[-+*/(),.=;:]/g) ?? [];
  expect(tokens.join("")).toBe(text.replace(/\s+/g, ""));
  let at = 0;
  const peek = () => tokens[at], next = () => tokens[at++]!;
  const expectToken = (token: string) => { if (next() !== token) throw new Error(`Expected ${token} near token ${at}`); };
  const call = (name: string, args: Value[]): Value => {
    if (/^vec[234]f?$/.test(name)) {
      const size = Number(name[3]), flat = args.flatMap(lanes);
      if (flat.length === 1) return Array<number>(size).fill(flat[0]!);
      if (flat.length !== size) throw new Error(`${name} of ${flat.length} lanes`);
      return flat;
    }
    const f = extra[name] ?? FUNCTIONS[name];
    if (!f) throw new Error(`Unknown function ${name}`);
    return f(...args);
  };
  const primary = (): Value => {
    const token = next();
    if (token === "(") { const value = expression(); expectToken(")"); return value; }
    if (/^\d/.test(token)) return Number(token);
    if (peek() === "(") {
      next();
      const args: Value[] = [];
      if (peek() !== ")") do args.push(expression()); while (peek() === "," && next());
      expectToken(")");
      return call(token, args);
    }
    const value = variables.get(token);
    if (value === undefined) throw new Error(`Unknown identifier ${token}`);
    return value;
  };
  const postfix = (): Value => {
    let value = primary();
    while (peek() === ".") {
      next();
      const picked = [...next()].map((channel) => lanes(value)["xyzw".indexOf(channel)]);
      if (picked.some((lane) => lane === undefined)) throw new Error("Swizzle past the vector");
      value = picked.length === 1 ? picked[0]! : (picked as number[]);
    }
    return value;
  };
  const unary = (): Value => (peek() === "-" ? (next(), each(unary(), (x) => -x)) : postfix());
  const term = (): Value => {
    let value = unary();
    while (peek() === "*" || peek() === "/") { const op = next(); value = combine(value, unary(), op === "*" ? (a, b) => a * b : (a, b) => a / b); }
    return value;
  };
  const expression = (): Value => {
    let value = term();
    while (peek() === "+" || peek() === "-") { const op = next(); value = combine(value, term(), op === "+" ? (a, b) => a + b : (a, b) => a - b); }
    return value;
  };
  const operators: Record<string, (a: number, b: number) => number> = { "+=": (a, b) => a + b, "-=": (a, b) => a - b, "*=": (a, b) => a * b, "/=": (a, b) => a / b };
  while (at < tokens.length) {
    let name = next();
    // `float name =` (GLSL) or `var name: f32 =` (WGSL).
    if (name === "var") { name = next(); expectToken(":"); next(); } else if (/^(float|vec[234])$/.test(name)) name = next();
    const op = next(), value = expression();
    expectToken(";");
    if (op === "=") variables.set(name, value);
    else if (operators[op]) variables.set(name, combine(variables.get(name)!, value, operators[op]!));
    else throw new Error(`Unsupported operator ${op}`);
  }
}

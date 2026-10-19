import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createFeatureTestProject,
  FEATURE_TEST_SCENES,
  openFeatureTestScene,
  seedEngineSettings,
  waitForTextureEncodes,
  type FeatureTestSceneName,
} from "./feature-test-project";
import { saveAllIfEnabled } from "./save-all";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

/**
 * FeatureTest cold-load route for shader compile work. Opt-in: BL_PERF_LOAD=1, through
 * playwright.perf.config.ts only.
 *
 * Creates the Feature Test starter, optionally switches the project backend, then opens each scene in
 * BL_PERF_SCENES once and records the scene-ready time and what the GPU API was asked to build while it
 * loaded: WebGL program links, WebGPU shader modules and render pipelines, each counted in total, by exact
 * source and by normalized source (define lines sorted apart from the body, SHADER_NAME dropped), which
 * also finds sources that differ only in define order or name. Every Babylon Effect the Engine creates is
 * recorded with its cache key kind (named shader, inline source, or a shadow-depth token), defines, render
 * pass, creation stack, cache hits and release, and the GPU objects it built; the report groups Effects
 * that built the same source, says why they missed the cache, and lists which define changes recompiled
 * one material. Haptic's water compile log (`__slateWaterCompileLog`) is included. Everything is captured
 * from page-level hooks installed before the editor boots; no editor code is touched. Counts are
 * hardware-independent; times compare only on one machine, backend and build. Never asserts timings.
 *
 * Env: BL_PERF_SCENES (comma list, default main), BL_PERF_BACKEND (webgl2|webgpu, default the project's
 *      WebGL2), BL_RENDER_NATIVE_GPU=1 (keep the project's launch arguments: perf-gpu), BL_PERF_SETTLE_MS
 *      (default 8000: how long after ready the settled window keeps counting), BL_PERF_LABEL, BL_PERF_OUT
 *      (extra report path).
 */
const ENABLED = process.env.BL_PERF_LOAD === "1";
const BACKEND = process.env.BL_PERF_BACKEND === "webgpu" ? "webgpu" : process.env.BL_PERF_BACKEND === "webgl2" ? "webgl2" : null;
const NATIVE_GPU = process.env.BL_RENDER_NATIVE_GPU === "1";
const SETTLE_MS = Number(process.env.BL_PERF_SETTLE_MS ?? 8_000);
const SCENES = (process.env.BL_PERF_SCENES ?? "main")
  .split(",")
  .map((scene) => scene.trim())
  .filter((scene): scene is FeatureTestSceneName => scene in FEATURE_TEST_SCENES);

if (!NATIVE_GPU)
  test.use({
    launchOptions: { args: [...(BACKEND === "webgpu" ? SOFTWARE_WEBGPU_ARGS : []), "--enable-precise-memory-info"] },
  });

type Counters = Record<string, number>;
interface WaterRequest {
  at: number; mesh: string; pass: number; mainPass: boolean; look: string; refraction: boolean; ssr: boolean; planar: boolean;
  fft: boolean; blend: boolean; shadows: string[]; depthPrePass: boolean; prePass: boolean; caller: string;
}
/** One GPU object build: [time, kind, raw source key, normalized key, body key, water, Effect id or -1, scene ready, phase]. */
type Creation = [number, string, string, string, string, number, number, number, string];
interface EffectRow {
  id: number;
  t: number;
  phase: string;
  ready: boolean;
  /** `name` (shader store name), `source` (inline source, e.g. NodeMaterial) or `token` (shadow-depth wrapper GUID). */
  kind: string;
  label: string;
  /** Hash of Babylon's cache key, and of its part before the defines (the shader identity). */
  key: string;
  base: string;
  defines: string;
  pass: number;
  frame: number;
  stack: string;
  hits: number;
  releasedAt: number | null;
  /** An earlier Effect with the same cache key was released before this one was created. */
  afterRelease: boolean;
  src: string | null;
  norm: string | null;
  body: string | null;
  links: number;
  modules: number;
  pipelines: number;
}
interface Owners {
  owners: Record<number, { count: number; first: string[] }>;
  buildIds: Record<number, string>;
  passNames: string[];
  scenes: Array<{ uid: string; meshes: number; materials: number }>;
}
interface Snapshot {
  now: number;
  readyAt: number | null;
  counters: Counters;
  creations: Creation[];
  effects: EffectRow[];
  water: WaterRequest[];
}

/** Page-level hooks, installed before the editor boots. */
async function installHooks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const host = globalThis as unknown as Record<string, unknown>;
    host.__slateWaterCompileLog = [];
    host.__ftLoadPhase = "boot";
    const phase = () => String(host.__ftLoadPhase);
    let readyAt: number | null = null;
    let sceneReady = false;
    const counters: Record<string, number> = {};
    const seen = new Set<string>();
    const creations: Array<[number, string, string, string, string, number, number, number, string]> = [];
    const bump = (name: string, by = 1) => { counters[name] = (counters[name] ?? 0) + by; };
    const hash = (text: string) => {
      let h = 2166136261;
      for (let index = 0; index < text.length; index++) { h ^= text.charCodeAt(index); h = Math.imul(h, 16777619); }
      return `${(h >>> 0).toString(36)}-${text.length}`;
    };
    // GLSL keeps `#define X` lines, WGSL gets them as `//#define X` comments; SHADER_NAME embeds a per-build name.
    const DEFINE_LINE = /^\s*(?:\/\/)?\s*#define\s+(.*)$/;
    const identity = (code: string) => {
      const defines: string[] = [];
      const body: string[] = [];
      for (const line of code.split("\n")) {
        const match = DEFINE_LINE.exec(line);
        if (!match) body.push(line);
        else if (!match[1]!.startsWith("SHADER_NAME")) defines.push(match[1]!.trim());
      }
      defines.sort();
      const bodyKey = hash(body.join("\n"));
      return { raw: hash(code), norm: `${hash(defines.join("\n"))}:${bodyKey}`, body: bodyKey };
    };
    const join = (parts: Array<{ raw: string; norm: string; body: string }>) => ({
      raw: parts.map((part) => part.raw).join("+"),
      norm: parts.map((part) => part.norm).join("+"),
      body: parts.map((part) => part.body).join("+"),
    });

    // Effects, from the Engine itself: Babylon's AbstractEngine constructor assigns `this._compiledEffects`,
    // which an inherited setter observes before any Effect exists.
    type EffectRow = {
      id: number; t: number; phase: string; ready: boolean; kind: string; label: string; key: string; base: string;
      defines: string; pass: number; frame: number; stack: string; hits: number; releasedAt: number | null;
      afterRelease: boolean; src: string | null; norm: string | null; body: string | null; links: number; modules: number; pipelines: number;
    };
    type AnyRecord = Record<string, unknown>;
    const effects: EffectRow[] = [];
    const rows = new Map<number, EffectRow>();
    const releasedKeys = new Set<string>();
    const engines: AnyRecord[] = [];
    // The Effect whose program is being built: its constructor (createEffect), its prepare, or a draw's pipeline.
    let current: EffectRow | null = null;
    let creating: EffectRow | null = null;
    const methodNames = (stack: string) => {
      const names: string[] = [];
      for (const line of stack.split("\n").slice(2)) {
        const match = /^\s*at (?:async )?(?:new )?([^\s(]+)/.exec(line);
        if (!match) continue;
        const full = match[1]!;
        const name = full.includes(".") ? full.slice(full.lastIndexOf(".") + 1) : full;
        // Minified bundle-local names are short; prototype method names survive minification.
        if (name.length < 4 || name === "<anonymous>" || /^https?:/.test(name)) continue;
        if (names[names.length - 1] !== name) names.push(name);
        if (names.length >= 16) break;
      }
      return names.join("<");
    };
    const stackOf = () => {
      const errorType = Error as unknown as { stackTraceLimit?: number };
      const limit = errorType.stackTraceLimit;
      errorType.stackTraceLimit = 60;
      const text = new Error().stack ?? "";
      errorType.stackTraceLimit = limit;
      return methodNames(text);
    };
    const sourcesOf = (effect: AnyRecord, row: EffectRow) => {
      const vertex = effect._vertexSourceCode;
      const fragment = effect._fragmentSourceCode;
      if (typeof vertex !== "string" || typeof fragment !== "string" || !vertex) return;
      const ids = join([identity(vertex), identity(fragment)]);
      row.src = ids.raw;
      row.norm = ids.norm;
      row.body = ids.body;
    };
    let effectPrototypeHooked = false;
    const hookEffectPrototype = (effect: AnyRecord) => {
      if (effectPrototypeHooked) return;
      effectPrototypeHooked = true;
      const prototype = Object.getPrototypeOf(effect) as AnyRecord;
      const prepare = prototype._prepareEffect as (this: AnyRecord, ...args: unknown[]) => unknown;
      if (typeof prepare !== "function") return;
      prototype._prepareEffect = function (this: AnyRecord, ...args: unknown[]) {
        const row = rows.get(this.uniqueId as number) ?? creating;
        if (row) sourcesOf(this, row);
        const previous = current;
        current = row;
        try {
          return prepare.apply(this, args);
        } finally {
          current = previous;
        }
      };
    };
    const hookPipelineCache = (engine: AnyRecord) => {
      const cache = engine._cacheRenderPipeline as AnyRecord | undefined;
      if (!cache || cache.__ftLoadHooked) return;
      cache.__ftLoadHooked = true;
      const create = cache._createRenderPipeline as (this: unknown, ...args: unknown[]) => unknown;
      if (typeof create !== "function") return;
      cache._createRenderPipeline = function (this: unknown, ...args: unknown[]) {
        const effect = args[0] as AnyRecord | undefined;
        const previous = current;
        current = (effect && rows.get(effect.uniqueId as number)) || null;
        try {
          return create.apply(this, args);
        } finally {
          current = previous;
        }
      };
    };
    const hookEngine = (engine: AnyRecord) => {
      if (engines.includes(engine)) return;
      engines.push(engine);
      const createEffect = engine.createEffect as (this: unknown, ...args: unknown[]) => AnyRecord | null;
      engine.createEffect = function (this: unknown, ...args: unknown[]) {
        hookPipelineCache(engine);
        const baseName = args[0] as string | AnyRecord;
        const options = args[1] as AnyRecord | undefined;
        const named = typeof baseName === "string";
        const kind = named ? "name" : baseName.vertexToken ? "token" : typeof baseName.vertexSource === "string" ? "source" : "name";
        const label = named ? baseName : kind === "token" ? "depthWrapper"
          : `${String(baseName.vertex ?? baseName.vertexElement ?? "inline")}+${String(baseName.fragment ?? baseName.fragmentElement ?? "inline")}`;
        const base = named ? baseName : kind === "name" ? label
          : `${hash(String(baseName.vertexSource ?? ""))}+${hash(String(baseName.fragmentSource ?? ""))}`;
        const defines = String((typeof args[4] === "string" ? args[4] : options?.defines) ?? "");
        const row: EffectRow = {
          id: -1, t: performance.now(), phase: phase(), ready: sceneReady, kind, label, key: "", base, defines,
          pass: Number(engine.currentRenderPassId ?? -1), frame: Number(engine.frameId ?? -1), stack: "", hits: 0,
          releasedAt: null, afterRelease: false, src: null, norm: null, body: null, links: 0, modules: 0, pipelines: 0,
        };
        const outer = creating;
        creating = row;
        let effect: AnyRecord | null;
        try {
          effect = createEffect.apply(this, args);
        } finally {
          creating = outer;
        }
        if (!effect) return effect;
        const id = effect.uniqueId as number;
        const known = rows.get(id);
        bump("effect.request");
        if (known) {
          known.hits += 1;
          return effect;
        }
        bump("effect.new");
        row.id = id;
        row.key = hash(String(effect._key ?? ""));
        row.afterRelease = releasedKeys.has(row.key);
        row.stack = stackOf();
        if (!row.src) sourcesOf(effect, row);
        rows.set(id, row);
        effects.push(row);
        hookEffectPrototype(effect);
        return effect;
      };
      const release = engine._releaseEffect as (this: unknown, effect: AnyRecord) => unknown;
      if (typeof release === "function")
        engine._releaseEffect = function (this: unknown, effect: AnyRecord) {
          const row = rows.get(effect?.uniqueId as number);
          if (row && row.releasedAt === null) {
            row.releasedAt = performance.now();
            releasedKeys.add(row.key);
            bump("effect.release");
          }
          return release.call(this, effect);
        };
    };
    Object.defineProperty(Object.prototype, "_compiledEffects", {
      configurable: true,
      get() { return undefined; },
      set(this: AnyRecord, value: unknown) {
        Object.defineProperty(this, "_compiledEffects", { value, writable: true, configurable: true, enumerable: true });
        if (typeof this.createEffect === "function" && typeof this._releaseEffect === "function")
          queueMicrotask(() => { try { hookEngine(this); } catch { /* attribution stays off */ } });
      },
    });

    const record = (kind: string, ids: { raw: string; norm: string; body: string }, water: boolean) => {
      bump(kind);
      if (water) bump(`${kind}.water`);
      for (const [suffix, key] of [["unique", ids.raw], ["normUnique", ids.norm]] as const) {
        const id = `${kind}:${suffix}:${key}`;
        if (!seen.has(id)) { seen.add(id); bump(`${kind}.${suffix}`); if (water && suffix === "unique") bump(`${kind}.waterUnique`); }
      }
      const owner = current ?? creating;
      if (owner) {
        if (kind === "gl.link") owner.links += 1;
        else if (kind === "gpu.shaderModule") owner.modules += 1;
        else owner.pipelines += 1;
      }
      if (creations.length < 20000)
        creations.push([performance.now(), kind, ids.raw, ids.norm, ids.body, water ? 1 : 0, owner ? owner.id : -1, sceneReady ? 1 : 0, phase()]);
      return owner;
    };
    // Rows still being constructed get their id when createEffect returns; patch the creations they own.
    const pendingCreations = new Map<object, number[]>();
    const remember = (owner: EffectRow | null) => {
      if (!owner || owner.id >= 0) return;
      const list = pendingCreations.get(owner) ?? [];
      list.push(creations.length - 1);
      pendingCreations.set(owner, list);
    };
    const settleCreations = () => {
      for (const [owner, indices] of pendingCreations) {
        const id = (owner as EffectRow).id;
        if (id < 0) continue;
        for (const index of indices) if (creations[index]) creations[index]![6] = id;
        pendingCreations.delete(owner);
      }
    };

    // WebGL: a program's identity is the pair of sources attached to it when it is linked.
    for (const name of ["WebGL2RenderingContext", "WebGLRenderingContext"] as const) {
      const proto = (globalThis as unknown as Record<string, { prototype: Record<string, unknown> } | undefined>)[name]?.prototype;
      if (!proto) continue;
      const sources = new WeakMap<object, string>();
      const attached = new WeakMap<object, object[]>();
      const shaderSource = proto.shaderSource as (shader: object, source: string) => void;
      proto.shaderSource = function (this: unknown, shader: object, source: string) {
        sources.set(shader, source);
        return shaderSource.call(this, shader, source);
      };
      const attachShader = proto.attachShader as (program: object, shader: object) => void;
      proto.attachShader = function (this: unknown, program: object, shader: object) {
        const list = attached.get(program) ?? [];
        list.push(shader);
        attached.set(program, list);
        return attachShader.call(this, program, shader);
      };
      const linkProgram = proto.linkProgram as (program: object) => void;
      proto.linkProgram = function (this: unknown, program: object) {
        const parts = (attached.get(program) ?? []).map((shader) => sources.get(shader) ?? "");
        remember(record("gl.link", join(parts.map(identity)), parts.some((part) => part.includes("vSlateWater"))));
        return linkProgram.call(this, program);
      };
    }

    // WebGPU: shader modules by source, pipelines by descriptor with modules replaced by their source keys.
    const Device = (globalThis as unknown as { GPUDevice?: { prototype: Record<string, unknown> } }).GPUDevice;
    if (Device) {
      const proto = Device.prototype;
      const modules = new WeakMap<object, { raw: string; norm: string; body: string; water: boolean }>();
      const createShaderModule = proto.createShaderModule as (descriptor: { code: string }) => object;
      proto.createShaderModule = function (this: unknown, descriptor: { code: string }) {
        const module = createShaderModule.call(this, descriptor);
        const water = descriptor.code.includes("vSlateWater");
        const ids = identity(descriptor.code);
        modules.set(module, { ...ids, water });
        remember(record("gpu.shaderModule", ids, water));
        return module;
      };
      for (const method of ["createRenderPipeline", "createRenderPipelineAsync"] as const) {
        const original = proto[method] as (descriptor: object) => unknown;
        proto[method] = function (this: unknown, descriptor: object) {
          let water = false;
          const keyed = (field: "raw" | "norm" | "body") => hash(JSON.stringify(descriptor, (name, value: unknown) => {
            if (name === "label") return undefined;
            if (value && typeof value === "object" && modules.has(value)) {
              const info = modules.get(value)!;
              water = water || info.water;
              return `module:${info[field]}`;
            }
            return value;
          }));
          remember(record(method === "createRenderPipeline" ? "gpu.pipeline" : "gpu.pipelineAsync",
            { raw: keyed("raw"), norm: keyed("norm"), body: keyed("body") }, water));
          return original.call(this, descriptor);
        };
      }
    }

    // Scene readiness, as the viewport panel publishes it.
    const watchReady = () => {
      const update = () => {
        const panel = document.querySelector('[data-testid="viewport-panel"]');
        const ready = panel?.getAttribute("data-scene-ready") === "true";
        if (ready && !sceneReady) readyAt = performance.now();
        sceneReady = ready;
      };
      new MutationObserver(update).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-scene-ready"], childList: true });
      update();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchReady, { once: true });
    else watchReady();

    /** Which live draw wrappers hold each Effect: scene, render pass, mesh and material. */
    const ownerSnapshot = () => {
      const owners: Record<number, { count: number; first: string[] }> = {};
      const buildIds: Record<number, string> = {};
      let passNames: string[] = [];
      const scenes: Array<{ uid: string; meshes: number; materials: number }> = [];
      const add = (effect: AnyRecord | null | undefined, label: string) => {
        if (!effect) return;
        const entry = (owners[effect.uniqueId as number] ??= { count: 0, first: [] });
        entry.count += 1;
        if (entry.first.length < 4) entry.first.push(label);
      };
      for (const engine of engines) {
        passNames = ((engine._renderPassNames as string[] | undefined) ?? []).slice();
        for (const [index, scene] of ((engine.scenes as AnyRecord[] | undefined) ?? []).entries()) {
          const meshes = (scene.meshes as AnyRecord[]) ?? [];
          const materials = (scene.materials as AnyRecord[]) ?? [];
          scenes.push({ uid: String(scene.uid), meshes: meshes.length, materials: materials.length });
          for (const mesh of meshes)
            for (const subMesh of (mesh.subMeshes as AnyRecord[] | undefined) ?? []) {
              const material = (subMesh.getMaterial as (() => AnyRecord | null) | undefined)?.call(subMesh);
              const wrappers = (subMesh._drawWrappers as Array<AnyRecord | undefined> | undefined) ?? [];
              wrappers.forEach((wrapper, pass) => add(wrapper?.effect as AnyRecord | undefined,
                `${index}|${passNames[pass] ?? pass}|${String(mesh.name)}|${String(material?.name ?? "?")}`));
              const override = subMesh._mainDrawWrapperOverride as AnyRecord | undefined;
              add(override?.effect as AnyRecord | undefined, `${index}|override|${String(mesh.name)}|${String(material?.name ?? "?")}`);
            }
          for (const material of materials) {
            if (typeof material.buildId === "number") buildIds[material.buildId] = `${index}|${String(material.name)}`;
            const depth = (material.shadowDepthWrapper as AnyRecord | null | undefined)?._subMeshToDepthWrapper as { mm?: Map<AnyRecord, Map<AnyRecord, AnyRecord>> } | undefined;
            for (const [subMesh, generators] of depth?.mm ?? [])
              for (const [generator, entry] of generators) {
                const light = (generator.getLight as (() => AnyRecord) | undefined)?.call(generator);
                const mesh = (subMesh?.getMesh as (() => AnyRecord) | undefined)?.call(subMesh);
                add((entry.mainDrawWrapper as AnyRecord | undefined)?.effect as AnyRecord | undefined,
                  `${index}|shadowDepth:${String(light?.name ?? "?")}|${String(mesh?.name ?? "?")}|${String(material.name)}`);
              }
          }
        }
      }
      return { owners, buildIds, passNames, scenes };
    };

    host.__ftLoad = {
      snapshot: () => {
        settleCreations();
        return {
          now: performance.now(),
          readyAt,
          counters: { ...counters },
          creations: creations.slice(),
          effects: effects.map((row) => ({ ...row })),
          water: JSON.parse(JSON.stringify(host.__slateWaterCompileLog)),
        };
      },
      owners: ownerSnapshot,
      setPhase: (value: string) => { host.__ftLoadPhase = value; },
    };
  });
}

const take = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => (globalThis as unknown as { __ftLoad: { snapshot: () => Snapshot } }).__ftLoad.snapshot());
const owners = (page: Page): Promise<Owners> =>
  page.evaluate(() => (globalThis as unknown as { __ftLoad: { owners: () => Owners } }).__ftLoad.owners());
const setPhase = (page: Page, value: string) =>
  page.evaluate((phase) => (globalThis as unknown as { __ftLoad: { setPhase: (value: string) => void } }).__ftLoad.setPhase(phase), value);

function delta(from: Snapshot, to: Snapshot): Counters {
  const out: Counters = {};
  for (const key of new Set([...Object.keys(from.counters), ...Object.keys(to.counters)])) {
    const change = (to.counters[key] ?? 0) - (from.counters[key] ?? 0);
    if (change) out[key] = change;
  }
  return out;
}

/** The GPU objects built in a window: total, distinct by exact and normalized source, and per kind. */
function creationWindow(from: Snapshot, to: Snapshot) {
  const rows = to.creations.slice(from.creations.length);
  const kinds = [...new Set(rows.map((row) => row[1]))];
  const perKind = Object.fromEntries(kinds.map((kind) => {
    const own = rows.filter((row) => row[1] === kind);
    return [kind, {
      total: own.length,
      distinct: new Set(own.map((row) => row[2])).size,
      distinctNormalized: new Set(own.map((row) => row[3])).size,
      water: own.filter((row) => row[5]).length,
      beforeReady: own.filter((row) => !row[7]).length,
      unattributed: own.filter((row) => row[6] < 0).length,
    }];
  }));
  const waterKeys = new Map<string, { kind: string; count: number; firstMs: number; lastMs: number }>();
  for (const [at, kind, raw, , , water] of rows) {
    if (!water) continue;
    const id = `${kind}:${raw}`;
    const row = waterKeys.get(id);
    if (row) { row.count += 1; row.lastMs = Math.round(at - from.now); }
    else waterKeys.set(id, { kind, count: 1, firstMs: Math.round(at - from.now), lastMs: Math.round(at - from.now) });
  }
  return {
    creations: rows.length,
    perKind,
    repeatedWater: [...waterKeys.entries()].filter(([, row]) => row.count > 1).map(([id, row]) => ({ id, ...row })),
    waterTimeline: rows.filter((row) => row[5]).map((row) => [Math.round(row[0] - from.now), row[1], row[2]]),
  };
}

const definesOf = (text: string) => new Set(text.split("\n").map((line) => line.replace(/^#define\s+/, "").trim()).filter(Boolean));

/**
 * Effects created in a window, grouped by the source they built. A group with several Effects is
 * avoidable work: Babylon's cache key separated identical shaders. The reason names why the keys differ.
 * The define-change histogram compares Effects of one shader identity (same pre-define source or name).
 */
function effectWindow(from: Snapshot, to: Snapshot, owned: Owners, withRows = true) {
  const startId = new Set(from.effects.map((row) => row.id));
  const rows = to.effects.filter((row) => !startId.has(row.id));
  const at = (ms: number) => Math.round(ms - from.now);
  const describe = (row: EffectRow) => {
    const owner = owned.owners[row.id];
    const build = /^nodeMaterial(\d+)\+/.exec(row.label);
    return {
      id: row.id, ms: at(row.t), kind: row.kind, label: row.label, material: build ? owned.buildIds[Number(build[1])] ?? null : null,
      pass: owned.passNames[row.pass] ?? row.pass, ready: row.ready, hits: row.hits, released: row.releasedAt === null ? null : at(row.releasedAt),
      afterRelease: row.afterRelease, links: row.links, modules: row.modules, pipelines: row.pipelines,
      owners: owner?.count ?? 0, firstOwners: owner?.first ?? [], stack: row.stack,
    };
  };
  const reason = (group: EffectRow[]) => {
    const keys = new Set(group.map((row) => row.key));
    if (keys.size === 1) return group.some((row) => row.afterRelease) ? "same key, recreated after release" : "same key, not cached";
    if (group.some((row) => row.kind === "token")) return group.every((row) => row.kind === "token") ? "shadow-depth token" : "shadow-depth token beside a keyed Effect";
    const bases = new Set(group.map((row) => row.base));
    const defines = new Set(group.map((row) => [...definesOf(row.defines)].sort().join("\n")));
    if (bases.size > 1 && defines.size === 1) return "same source under different shader names";
    if (defines.size === 1) return "defines differ only in order";
    return "keys differ in defines that do not change the source";
  };
  const groupBy = (field: "src" | "norm") => {
    const groups = new Map<string, EffectRow[]>();
    for (const row of rows) {
      if (!row[field]) continue;
      const list = groups.get(row[field]!) ?? [];
      list.push(row);
      groups.set(row[field]!, list);
    }
    return [...groups.values()].filter((group) => group.length > 1);
  };
  const exact = groupBy("src");
  const normalized = groupBy("norm").filter((group) => new Set(group.map((row) => row.src)).size > 1);
  const reasons: Record<string, { groups: number; extraEffects: number; extraLinks: number; extraModules: number; extraPipelines: number }> = {};
  for (const group of exact) {
    const entry = (reasons[reason(group)] ??= { groups: 0, extraEffects: 0, extraLinks: 0, extraModules: 0, extraPipelines: 0 });
    entry.groups += 1;
    entry.extraEffects += group.length - 1;
    const [, ...rest] = [...group].sort((a, b) => a.t - b.t);
    for (const row of rest) { entry.extraLinks += row.links; entry.extraModules += row.modules; entry.extraPipelines += row.pipelines; }
  }
  // Define changes inside one shader identity, oldest Effect first.
  const identities = new Map<string, EffectRow[]>();
  for (const row of rows) {
    const list = identities.get(`${row.kind}:${row.base}`) ?? [];
    list.push(row);
    identities.set(`${row.kind}:${row.base}`, list);
  }
  const changes = new Map<string, { count: number; generic: string; example: string }>();
  const generic = new Map<string, number>();
  for (const list of identities.values()) {
    const sorted = [...list].sort((a, b) => a.t - b.t);
    for (let index = 1; index < sorted.length; index += 1) {
      const current = definesOf(sorted[index]!.defines);
      // Nearest earlier variant: the define change that produced this Effect.
      let best: { plus: string[]; minus: string[] } | null = null;
      for (let earlier = 0; earlier < index; earlier += 1) {
        const previous = definesOf(sorted[earlier]!.defines);
        const plus = [...current].filter((entry) => !previous.has(entry)).sort();
        const minus = [...previous].filter((entry) => !current.has(entry)).sort();
        if (!best || plus.length + minus.length < best.plus.length + best.minus.length) best = { plus, minus };
      }
      if (!best) continue;
      const signature = [...best.plus.map((entry) => `+${entry}`), ...best.minus.map((entry) => `-${entry}`)].join(" ") || "(none)";
      const loose = signature.replace(/\d+/g, "#");
      const entry = changes.get(signature) ?? { count: 0, generic: loose, example: sorted[index]!.label };
      entry.count += 1;
      changes.set(signature, entry);
      generic.set(loose, (generic.get(loose) ?? 0) + 1);
    }
  }
  const stackSignatures = new Map<string, number>();
  for (const row of rows) stackSignatures.set(`${row.kind}:${row.stack.split("<").slice(0, 7).join("<")}`, (stackSignatures.get(`${row.kind}:${row.stack.split("<").slice(0, 7).join("<")}`) ?? 0) + 1);
  return {
    effects: rows.length,
    byKind: Object.fromEntries([...new Set(rows.map((row) => row.kind))].map((kind) => [kind, rows.filter((row) => row.kind === kind).length])),
    beforeReady: rows.filter((row) => !row.ready).length,
    released: rows.filter((row) => row.releasedAt !== null).length,
    createdAfterRelease: rows.filter((row) => row.afterRelease).length,
    distinctSources: new Set(rows.map((row) => row.src)).size,
    distinctNormalized: new Set(rows.map((row) => row.norm)).size,
    duplicateReasons: reasons,
    duplicateGroups: exact.sort((a, b) => b.length - a.length).slice(0, 60).map((group) => ({ reason: reason(group), effects: group.length, members: group.map(describe) })),
    normalizedOnlyGroups: normalized.slice(0, 30).map((group) => ({ effects: group.length, members: group.map(describe), defines: group.map((row) => row.defines.slice(0, 4000)) })),
    defineChanges: [...changes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 60).map(([signature, entry]) => ({ signature, ...entry })),
    defineChangesGeneric: [...generic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([signature, count]) => ({ signature, count })),
    stacks: [...stackSignatures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([stack, count]) => ({ count, stack })),
    rows: withRows ? rows.map((row) => ({ ...describe(row), defines: row.defines.slice(0, 6000), base: row.base, key: row.key, src: row.src, norm: row.norm })) : [],
  };
}

/** The water compile log in a window: one row per variant request, times relative to the window start. */
function waterWindow(from: Snapshot, to: Snapshot) {
  const rows = to.water.slice(from.water.length);
  const compact = rows.map((row) => ({
    ms: Math.round(row.at - from.now), mesh: row.mesh, pass: row.pass, main: row.mainPass, look: row.look,
    refr: row.refraction, ssr: row.ssr, planar: row.planar, fft: row.fft, blend: row.blend,
    shadows: row.shadows.join(","), depth: row.depthPrePass, prepass: row.prePass,
  }));
  const signature = (row: (typeof compact)[number]) => JSON.stringify({ ...row, ms: undefined, mesh: undefined, pass: undefined });
  return { requests: compact.length, distinctSignatures: new Set(compact.map(signature)).size, requestsDetail: compact.slice(0, 200) };
}

test.skip(!ENABLED, "FeatureTest cold-load route; set BL_PERF_LOAD=1 to run it.");

test("FeatureTest cold-load route", async ({ page }, testInfo) => {
  test.setTimeout(60 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installHooks(page);
  await seedEngineSettings(page);
  await setPhase(page, "create");
  const hooksStart = await take(page);
  const createToInteractiveMs = await createFeatureTestProject(page);
  await waitForTextureEncodes(page);
  const afterCreate = await take(page);
  const backendNow = () =>
    page.evaluate(() => (globalThis as unknown as { __babylonslateViewportTest?: { renderingBaseline: () => { backend: string } | null } })
      .__babylonslateViewportTest?.renderingBaseline()?.backend ?? null);
  const switchStarted = Date.now();
  await setPhase(page, "backend");
  if (BACKEND) {
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-rendering").click();
    await page.getByTestId("project-gpu-backend").click();
    await page.getByRole("option", { name: BACKEND === "webgpu" ? "WebGPU" : "WebGL2", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await saveAllIfEnabled(page, 300_000);
  }
  const backendSwitchMs = BACKEND ? Date.now() - switchStarted : null;
  const afterSwitch = await take(page);

  const adapter = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const webgl = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    let webgpu: Record<string, unknown> | null = null;
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<{ info?: Record<string, unknown> } | null> } }).gpu;
      const found = await gpu?.requestAdapter();
      if (found?.info) webgpu = { vendor: found.info.vendor, architecture: found.info.architecture, description: found.info.description, device: found.info.device };
    } catch { /* WebGPU unavailable. */ }
    return { webgl, webgpu };
  });

  const scenes: Record<string, unknown> = {};
  const report = () => ({
    qualification:
      "Cold scene load on this machine's adapter; counts are hardware-independent, times compare only on the same machine, backend and build. No timing assertion.",
    label: process.env.BL_PERF_LABEL ?? null,
    browserProject: testInfo.project.name,
    browserVersion: page.context().browser()?.version() ?? null,
    adapter,
    env: { SCENES, BACKEND, NATIVE_GPU, SETTLE_MS },
    createToInteractiveMs,
    backendSwitchMs,
    // No scene is open after project creation, so these windows hold only the project's own start-up work.
    startup: {
      create: { counters: delta(hooksStart, afterCreate), gpu: creationWindow(hooksStart, afterCreate) },
      backendSwitch: { counters: delta(afterCreate, afterSwitch), gpu: creationWindow(afterCreate, afterSwitch) },
    },
    scenes,
    pageErrors,
  });
  const write = () => {
    const body = JSON.stringify(report(), null, 1);
    writeFileSync(testInfo.outputPath("feature-test-load.json"), body);
    if (process.env.BL_PERF_OUT) {
      mkdirSync(path.dirname(process.env.BL_PERF_OUT), { recursive: true });
      writeFileSync(process.env.BL_PERF_OUT, body);
    }
    return body;
  };
  write();
  for (const scene of SCENES) {
    await setPhase(page, `open:${scene}`);
    const before = await take(page);
    const { readyMs, loadRetries } = await openFeatureTestScene(page, scene);
    const ready = await take(page);
    const readyOwners = await owners(page);
    await setPhase(page, `settle:${scene}`);
    if (BACKEND) await expect.poll(backendNow, { timeout: 120_000 }).toBe(BACKEND);
    await page.waitForTimeout(SETTLE_MS);
    const settled = await take(page);
    const settledOwners = await owners(page);
    scenes[scene] = {
      sceneReadyMs: readyMs,
      loadRetries,
      backend: await backendNow(),
      liveScenes: settledOwners.scenes,
      load: { counters: delta(before, ready), gpu: creationWindow(before, ready), effects: effectWindow(before, ready, readyOwners), water: waterWindow(before, ready) },
      settled: { afterMs: SETTLE_MS, counters: delta(ready, settled), gpu: creationWindow(ready, settled), effects: effectWindow(ready, settled, settledOwners), water: waterWindow(ready, settled) },
      whole: { counters: delta(before, settled), gpu: creationWindow(before, settled), effects: effectWindow(before, settled, settledOwners, false) },
    };
    write();
  }
  await testInfo.attach("feature-test-load", { body: write(), contentType: "application/json" });
  expect(SCENES.length).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

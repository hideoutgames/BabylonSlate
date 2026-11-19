import type { Page } from "@playwright/test";

/**
 * A ledger of what the page asks WebGL to allocate, for local memory timelines (the FeatureTest perf route's
 * `HAPTIC_PERF_MEMORY`). Installed before the editor boots, it wraps the allocating calls of every WebGL2 context:
 * texture storage (`texImage*`, `texStorage*`, `compressedTexImage*`, by level, face and layer), renderbuffer storage
 * (multisampled ones by their sample count), buffer data and programs. It counts what the page asked for, not what the
 * driver holds: the default framebuffer, driver padding and shader binaries are not in it.
 *
 * Every allocation or release of at least `EVENT_BYTES` is logged with its time, and the totals are sampled every
 * `intervalMs`, with the programs linked and still compiling (linked, and not yet reported complete or linked to
 * Babylon's completion and link status queries).
 */
const EVENT_BYTES = 4 * 1024 ** 2;

export type GlMemorySample = [
  at: number, textureBytes: number, textures: number, renderbufferBytes: number, renderbuffers: number,
  bufferBytes: number, programs: number, compiling: number, compilingPeak: number, heapBytes: number,
];
export type GlMemoryEvent = { at: number; kind: string; bytes: number; detail: string };
export type GlLiveObject = { kind: string; bytes: number; detail: string; since: number };

export async function installGlMemoryLedger(page: Page, intervalMs: number): Promise<void> {
  await page.addInitScript(({ interval, eventBytes }) => {
    type Owner = { bytes: Map<string, number>; detail: string; since: number; kind: string };
    const samples: number[][] = [];
    const events: Array<{ at: number; kind: string; bytes: number; detail: string }> = [];
    const owners = new Map<object, Owner>();
    const totals = { texture: 0, renderbuffer: 0, buffer: 0, textures: 0, renderbuffers: 0 };
    const compiling = new Set<WebGLProgram>();
    let programs = 0;
    let compilingPeak = 0;
    type State = { unit: number; textures: Map<string, WebGLTexture | null>; renderbuffer: WebGLRenderbuffer | null; buffers: Map<number, WebGLBuffer | null> };
    const states = new WeakMap<object, State>();
    const contexts: WebGL2RenderingContext[] = [];
    const state = (gl: WebGL2RenderingContext) => {
      let found = states.get(gl);
      if (!found) {
        found = { unit: 0x84c0, textures: new Map(), renderbuffer: null, buffers: new Map() };
        states.set(gl, found);
        contexts.push(gl);
      }
      return found;
    };
    const SIZED: Record<number, number> = {
      0x8058: 4, 0x8c43: 4, 0x881a: 8, 0x8814: 16, 0x8229: 1, 0x822b: 2, 0x822d: 2, 0x822f: 4, 0x822e: 4, 0x8230: 8,
      0x8c3a: 4, 0x8059: 4, 0x8051: 4, 0x881b: 8, 0x8815: 16, 0x81a5: 2, 0x81a6: 4, 0x8cac: 4, 0x88f0: 4, 0x8cad: 8,
      0x8d48: 1, 0x8d7c: 4, 0x8236: 4, 0x823c: 8, 0x8d70: 16, 0x8234: 2, 0x8d76: 8, 0x8235: 4, 0x8232: 1, 0x8238: 2,
      0x8c41: 4, 0x8d62: 2, 0x8056: 2, 0x8057: 2, 0x8f97: 4, 0x8c3d: 4, 0x8233: 2, 0x823a: 4, 0x8231: 1,
    };
    const FORMAT_NAMES: Record<number, string> = { 0x8cac: "DEPTH32F", 0x88f0: "D24S8", 0x81a6: "DEPTH24", 0x81a5: "DEPTH16", 0x8cad: "D32FS8", 0x8058: "RGBA8", 0x881a: "RGBA16F", 0x8814: "RGBA32F", 0x8c3a: "R11G11B10F", 0x8c43: "SRGB8A8", 0x8229: "R8", 0x822b: "RG8", 0x822d: "R16F", 0x822f: "RG16F", 0x822e: "R32F", 0x8230: "RG32F", 0x8059: "RGB10A2" };
    const channels = (format: number) => ({ 0x1908: 4, 0x1907: 3, 0x8227: 2, 0x1903: 1, 0x1909: 1, 0x1906: 1, 0x190a: 2, 0x1902: 1, 0x84f9: 1, 0x8d99: 4, 0x8d94: 1 }[format] ?? 4);
    const typeBytes = (type: number) => ({ 0x1406: 4, 0x140b: 2, 0x8d61: 2, 0x1405: 4, 0x1404: 4, 0x1403: 2, 0x1402: 2, 0x84fa: 4, 0x8dad: 8 }[type] ?? 1);
    const texelBytes = (internal: number, format?: number, type?: number) =>
      SIZED[internal] ?? (format !== undefined && type !== undefined ? channels(format) * typeBytes(type) : 4);
    const name = (internal: number) => FORMAT_NAMES[internal] ?? `0x${internal.toString(16)}`;
    const now = () => performance.now();
    const set = (kind: "texture" | "renderbuffer" | "buffer", object: object | null | undefined, key: string, bytes: number, detail: string) => {
      if (!object) return;
      let owner = owners.get(object);
      if (!owner) {
        owner = { bytes: new Map(), detail, since: now(), kind };
        owners.set(object, owner);
        if (kind === "texture") totals.textures += 1;
        if (kind === "renderbuffer") totals.renderbuffers += 1;
      }
      const before = owner.bytes.get(key) ?? 0;
      owner.bytes.set(key, bytes);
      if (bytes >= (owner.bytes.size === 1 ? 0 : before)) owner.detail = detail;
      totals[kind] += bytes - before;
      if (Math.abs(bytes - before) >= eventBytes) events.push({ at: now(), kind: `${kind} ${bytes > before ? "alloc" : "shrink"}`, bytes: bytes - before, detail });
    };
    const release = (kind: "texture" | "renderbuffer" | "buffer", object: object | null | undefined) => {
      const owner = object && owners.get(object);
      if (!owner) return;
      let bytes = 0;
      for (const value of owner.bytes.values()) bytes += value;
      totals[kind] -= bytes;
      if (kind === "texture") totals.textures -= 1;
      if (kind === "renderbuffer") totals.renderbuffers -= 1;
      owners.delete(object);
      if (bytes >= eventBytes) events.push({ at: now(), kind: `${kind} free`, bytes: -bytes, detail: owner.detail });
    };
    const CUBE_FACE = (target: number) => target >= 0x8515 && target <= 0x851a;
    const bound = (gl: WebGL2RenderingContext, target: number) => {
      const s = state(gl);
      return s.textures.get(`${s.unit}:${CUBE_FACE(target) ? 0x8513 : target}`) ?? null;
    };
    const proto = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const wrap = (method: string, before: (gl: WebGL2RenderingContext, args: unknown[]) => void, after?: (gl: WebGL2RenderingContext, args: unknown[], result: unknown) => void) => {
      const original = proto[method]!;
      proto[method] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
        try { before(this, args); } catch { /* the ledger never breaks a call */ }
        const result = original.apply(this, args);
        if (after) try { after(this, args, result); } catch { /* as above */ }
        return result;
      };
    };
    wrap("activeTexture", (gl, [unit]) => { state(gl).unit = unit as number; });
    wrap("bindTexture", (gl, [target, texture]) => { const s = state(gl); s.textures.set(`${s.unit}:${target}`, texture as WebGLTexture | null); });
    wrap("bindRenderbuffer", (gl, [, renderbuffer]) => { state(gl).renderbuffer = renderbuffer as WebGLRenderbuffer | null; });
    wrap("bindBuffer", (gl, [target, buffer]) => { state(gl).buffers.set(target as number, buffer as WebGLBuffer | null); });
    wrap("deleteTexture", (_gl, [texture]) => release("texture", texture as object));
    wrap("deleteRenderbuffer", (_gl, [renderbuffer]) => release("renderbuffer", renderbuffer as object));
    wrap("deleteBuffer", (_gl, [buffer]) => release("buffer", buffer as object));
    const sourceSize = (source: unknown) => {
      const s = source as { width?: number; height?: number; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; codedWidth?: number; codedHeight?: number; displayWidth?: number; displayHeight?: number } | null;
      return [s?.videoWidth || s?.naturalWidth || s?.displayWidth || s?.width || 0, s?.videoHeight || s?.naturalHeight || s?.displayHeight || s?.height || 0];
    };
    wrap("texImage2D", (gl, args) => {
      const [target, level, internal] = args as number[];
      let width: number, height: number, format: number, type: number;
      if (args.length >= 8 && typeof args[3] === "number" && typeof args[4] === "number" && typeof args[5] === "number") {
        [width, height, , format, type] = (args as number[]).slice(3, 8) as [number, number, number, number, number];
      } else {
        [format, type] = (args as number[]).slice(3, 5) as [number, number];
        [width, height] = sourceSize(args[5]);
      }
      set("texture", bound(gl, target!), `${target}:${level}`, width! * height! * texelBytes(internal!, format!, type!), `2D ${width}x${height} ${name(internal!)}`);
    });
    wrap("texImage3D", (gl, args) => {
      const [target, level, internal, width, height, depth, , format, type] = args as number[];
      set("texture", bound(gl, target!), `${target}:${level}`, width! * height! * depth! * texelBytes(internal!, format, type), `${target === 0x806f ? "3D" : "array"} ${width}x${height}x${depth} ${name(internal!)}`);
    });
    wrap("texStorage2D", (gl, args) => {
      const [target, levels, internal, width, height] = args as number[];
      let bytes = 0;
      for (let level = 0, w = width!, h = height!; level < levels!; level++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) bytes += w * h * texelBytes(internal!);
      if (target === 0x8513) bytes *= 6;
      set("texture", bound(gl, target!), "storage", bytes, `${target === 0x8513 ? "cube" : "2D"} ${width}x${height} ${name(internal!)} x${levels} levels`);
    });
    wrap("texStorage3D", (gl, args) => {
      const [target, levels, internal, width, height, depth] = args as number[];
      let bytes = 0;
      for (let level = 0, w = width!, h = height!, d = depth!; level < levels!; level++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1), d = target === 0x806f ? Math.max(1, d >> 1) : d) bytes += w * h * d * texelBytes(internal!);
      set("texture", bound(gl, target!), "storage", bytes, `${target === 0x806f ? "3D" : "array"} ${width}x${height}x${depth} ${name(internal!)} x${levels} levels`);
    });
    const compressedBytes = (args: unknown[], sizeIndex: number) => {
      const data = args[sizeIndex] as ArrayBufferView | number | undefined;
      return typeof data === "number" ? data : ((data as ArrayBufferView | undefined)?.byteLength ?? 0);
    };
    wrap("compressedTexImage2D", (gl, args) => {
      const [target, level, internal, width, height] = args as number[];
      set("texture", bound(gl, target!), `${target}:${level}`, compressedBytes(args, 6), `2D ${width}x${height} compressed 0x${internal!.toString(16)}`);
    });
    wrap("compressedTexImage3D", (gl, args) => {
      const [target, level, internal, width, height, depth] = args as number[];
      set("texture", bound(gl, target!), `${target}:${level}`, compressedBytes(args, 7), `array ${width}x${height}x${depth} compressed 0x${internal!.toString(16)}`);
    });
    wrap("renderbufferStorage", (gl, [, internal, width, height]) => {
      set("renderbuffer", state(gl).renderbuffer, "storage", (width as number) * (height as number) * texelBytes(internal as number), `${width}x${height} ${name(internal as number)}`);
    });
    wrap("renderbufferStorageMultisample", (gl, [, samples, internal, width, height]) => {
      set("renderbuffer", state(gl).renderbuffer, "storage", (width as number) * (height as number) * texelBytes(internal as number) * Math.max(1, samples as number),
        `${width}x${height} ${name(internal as number)} x${samples} samples`);
    });
    wrap("bufferData", (gl, [target, data]) => {
      const bytes = typeof data === "number" ? data : ((data as ArrayBufferView | ArrayBuffer | null)?.byteLength ?? 0);
      set("buffer", state(gl).buffers.get(target as number), "data", bytes, `buffer 0x${(target as number).toString(16)} ${bytes} bytes`);
    });
    wrap("createProgram", () => {}, (_gl, _args, program) => { if (program) programs += 1; });
    wrap("deleteProgram", (_gl, [program]) => { if (program) { programs -= 1; compiling.delete(program as WebGLProgram); } });
    wrap("linkProgram", (_gl, [program]) => {
      compiling.add(program as WebGLProgram);
      compilingPeak = Math.max(compilingPeak, compiling.size);
    });
    wrap("getProgramParameter", () => {}, (_gl, [program, pname], result) => {
      // COMPLETION_STATUS_KHR answered true, or LINK_STATUS (which waits for the link): the program is no longer compiling.
      if ((pname === 0x91b1 && result === true) || pname === 0x8b82) compiling.delete(program as WebGLProgram);
    });
    const memory = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    setInterval(() => {
      samples.push([now(), totals.texture, totals.textures, totals.renderbuffer, totals.renderbuffers, totals.buffer, programs, compiling.size, compilingPeak, memory()]);
      compilingPeak = compiling.size;
    }, interval);
    (globalThis as unknown as { __glMemoryLedger: unknown }).__glMemoryLedger = {
      samples, events,
      live: (minBytes: number) => {
        const list: Array<{ kind: string; bytes: number; detail: string; since: number }> = [];
        for (const owner of owners.values()) {
          let bytes = 0;
          for (const value of owner.bytes.values()) bytes += value;
          if (bytes >= minBytes) list.push({ kind: owner.kind, bytes, detail: owner.detail, since: owner.since });
        }
        return list.sort((a, b) => b.bytes - a.bytes);
      },
      contexts: () => contexts.map((gl) => {
        const attributes = gl.getContextAttributes();
        return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, antialias: attributes?.antialias ?? null, depth: attributes?.depth ?? null, stencil: attributes?.stencil ?? null };
      }),
    };
  }, { interval: intervalMs, eventBytes: EVENT_BYTES });
}

/** What the ledger holds now: samples and events since `since` (a page `performance.now()` time), and live objects. */
export async function readGlMemoryLedger(page: Page, since: number, liveMinBytes = 1024 ** 2) {
  return page.evaluate(([from, minBytes]) => {
    const ledger = (globalThis as unknown as {
      __glMemoryLedger?: {
        samples: number[][]; events: Array<{ at: number }>;
        live: (min: number) => unknown[]; contexts: () => unknown[];
      };
    }).__glMemoryLedger;
    if (!ledger) return null;
    return {
      timeOrigin: performance.timeOrigin,
      samples: ledger.samples.filter(([at]) => at! >= from!),
      events: ledger.events.filter((event) => event.at >= from!),
      live: ledger.live(minBytes!),
      contexts: ledger.contexts(),
    };
  }, [since, liveMinBytes] as const);
}

/** The live objects of at least `minBytes`, largest first, and the page time they were read. */
export async function glLiveObjects(page: Page, minBytes = 1024 ** 2): Promise<{ at: number; live: GlLiveObject[] } | null> {
  return page.evaluate((min) => {
    const ledger = (globalThis as unknown as { __glMemoryLedger?: { live: (min: number) => GlLiveObject[] } }).__glMemoryLedger;
    return ledger ? { at: performance.now(), live: ledger.live(min) } : null;
  }, minBytes);
}

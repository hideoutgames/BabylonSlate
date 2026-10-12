/**
 * Opt-in WebGL call tracing for device diagnostics. `getError` only says that
 * some earlier call failed; while installed, every context call is followed by
 * a `getError`, so the failing call is recorded with its arguments and stack.
 * Recorded codes are handed back by the wrapped `getError` in order, so the
 * engine's own checks (scene presentation, capture) see exactly what they
 * would have seen without tracing. Expensive: each call adds a sync query.
 */
export interface GlErrorTraceEntry {
  time: number;
  call: string;
  code: number;
  args: string;
  /** Names of the calls just before the failing one, oldest first. */
  before: string[];
  stack: string[];
  /** For a failing draw: blending, draw buffers, attachments and the program's defines. */
  state?: string[];
}

const DRAW_CALLS = new Set(["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]);
/** The arguments of the newest drawBuffers call per context, for failing-draw state. */
const lastDrawBuffers = new WeakMap<object, string>();
const STATE_INTERVAL_MS = 2_000;
let lastStateAt = -Infinity;

const CODE_NAMES: Record<number, string> = {
  0x0500: "INVALID_ENUM",
  0x0501: "INVALID_VALUE",
  0x0502: "INVALID_OPERATION",
  0x0505: "OUT_OF_MEMORY",
  0x0506: "INVALID_FRAMEBUFFER_OPERATION",
  0x9242: "CONTEXT_LOST_WEBGL",
};
const ENTRY_CAP = 30;
const RECENT_CALLS = 8;
const entries: GlErrorTraceEntry[] = [];
const pending = new WeakMap<object, number[]>();
const recent: string[] = [];
let installs = 0;
let restore: (() => void) | null = null;

function describeArg(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number") return Number.isInteger(value) && value >= 0x0200 ? `0x${value.toString(16)}` : String(value);
  if (typeof value === "boolean" || typeof value === "string") return String(value).slice(0, 40);
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${(value as ArrayBufferView).byteLength}B)`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  const named = value as { constructor?: { name?: string }; width?: number; height?: number };
  return `${named.constructor?.name ?? "object"}${named.width !== undefined ? ` ${named.width}x${named.height}` : ""}`;
}

type Native = (...args: unknown[]) => unknown;

/** Reads state through the native methods, so the queries are neither traced nor counted. */
function describeDrawState(gl: WebGL2RenderingContext, native: Map<string, Native>): string[] {
  const call = (name: string, ...args: unknown[]) => native.get(name)?.apply(gl, args);
  const lines: string[] = [];
  try {
    const ext = (call("getSupportedExtensions") as string[] | null) ?? [];
    const has = (name: string) => (ext.includes(name) ? "yes" : "no");
    lines.push(`extensions: EXT_color_buffer_float ${has("EXT_color_buffer_float")} · EXT_float_blend ${has("EXT_float_blend")} · OES_draw_buffers_indexed ${has("OES_draw_buffers_indexed")}`);
    const blend = call("isEnabled", gl.BLEND) as boolean;
    lines.push(`blend ${blend ? "on" : "off"} · depth test ${(call("isEnabled", gl.DEPTH_TEST) as boolean) ? "on" : "off"} · stencil test ${(call("isEnabled", gl.STENCIL_TEST) as boolean) ? "on" : "off"} · drawBuffers(${lastDrawBuffers.get(gl) ?? "never called"})`);
    const framebuffer = call("getParameter", gl.DRAW_FRAMEBUFFER_BINDING);
    if (!framebuffer) {
      lines.push("draw framebuffer: default canvas");
    } else {
      const max = Math.min(8, (call("getParameter", gl.MAX_COLOR_ATTACHMENTS) as number) || 4);
      const attachments: string[] = [];
      for (let index = 0; index < max; index++) {
        const point = gl.COLOR_ATTACHMENT0 + index;
        const type = call("getFramebufferAttachmentParameter", gl.DRAW_FRAMEBUFFER, point, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) as number;
        if (!type) continue;
        const component = call("getFramebufferAttachmentParameter", gl.DRAW_FRAMEBUFFER, point, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) as number;
        const bits = [gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE, gl.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE, gl.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE, gl.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE]
          .map((pname) => call("getFramebufferAttachmentParameter", gl.DRAW_FRAMEBUFFER, point, pname) as number);
        const componentName = component === gl.FLOAT ? "float" : component === gl.INT ? "int" : component === gl.UNSIGNED_INT ? "uint" : component === gl.UNSIGNED_NORMALIZED ? "unorm" : component === gl.SIGNED_NORMALIZED ? "snorm" : `0x${(component ?? 0).toString(16)}`;
        attachments.push(`${index}:${type === gl.TEXTURE ? "tex" : "rb"} ${componentName} ${bits.join("/")}`);
      }
      lines.push(`draw framebuffer attachments: ${attachments.join(", ") || "none"}`);
    }
    const program = call("getParameter", gl.CURRENT_PROGRAM);
    const shaders = program ? (call("getAttachedShaders", program) as WebGLShader[] | null) ?? [] : [];
    for (const shader of shaders) {
      if (call("getShaderParameter", shader, gl.SHADER_TYPE) !== gl.FRAGMENT_SHADER) continue;
      const source = (call("getShaderSource", shader) as string | null) ?? "";
      const defines = source.split("\n").filter((line) => line.startsWith("#define")).map((line) => line.slice(8).trim());
      const outputs = source.split("\n").filter((line) => /^\s*(layout\s*\(.*\)\s*)?out\s/.test(line)).map((line) => line.trim());
      lines.push(`fragment outputs: ${outputs.join(" | ").slice(0, 300) || "none found"}`);
      lines.push(`fragment defines (${defines.length}): ${defines.join(", ").slice(0, 600)}`);
    }
  } catch (error) {
    lines.push(`state unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return lines;
}

function wrap(proto: object): () => void {
  const originals = new Map<string, Native>();
  const target = proto as Record<string, unknown>;
  const getError = target.getError as (this: WebGL2RenderingContext) => number;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor" || name === "getError" || name === "isContextLost") continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    originals.set(name, original);
    target[name] = function traced(this: WebGL2RenderingContext, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (name === "drawBuffers") lastDrawBuffers.set(this, String(args[0] instanceof Array ? args[0].map((value) => value === 0 ? "NONE" : value === 0x0405 ? "BACK" : `C${Number(value) - 0x8ce0}`).join(",") : args[0]));
      recent.push(name);
      if (recent.length > RECENT_CALLS + 1) recent.shift();
      const code = getError.call(this);
      if (code !== 0) {
        const queue = pending.get(this) ?? [];
        queue.push(code);
        pending.set(this, queue);
        entries.push({
          time: Date.now(), call: name, code, args: args.map(describeArg).join(", ").slice(0, 200),
          before: recent.slice(0, -1), stack: (new Error().stack ?? "").split("\n").slice(2, 8).map((line) => line.trim()),
          // A burst of failing draws repeats one cause; only the first in each burst pays for the state query.
          state: DRAW_CALLS.has(name) && Date.now() - lastStateAt > STATE_INTERVAL_MS ? (lastStateAt = Date.now(), describeDrawState(this, originals)) : undefined,
        });
        if (entries.length > ENTRY_CAP) entries.splice(0, entries.length - ENTRY_CAP);
      }
      return result;
    };
  }
  target.getError = function tracedGetError(this: WebGL2RenderingContext) {
    const queue = pending.get(this);
    if (queue?.length) return queue.shift()!;
    return getError.call(this);
  };
  return () => {
    for (const [name, original] of originals) target[name] = original;
    target.getError = getError;
  };
}

/** Reference counted; uninstalling the last owner restores the native methods. */
export function installGlErrorTrace(): () => void {
  installs += 1;
  if (installs === 1) {
    // A fresh trace: earlier sessions' failures would only mislead a new report.
    entries.length = 0;
    lastStateAt = -Infinity;
    const undo = [globalThis.WebGL2RenderingContext?.prototype, globalThis.WebGLRenderingContext?.prototype]
      .filter((proto): proto is WebGL2RenderingContext => Boolean(proto))
      .map(wrap);
    restore = () => { for (const step of undo) step(); };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installs -= 1;
    if (installs === 0) { restore?.(); restore = null; }
  };
}

export function glErrorTraceActive(): boolean {
  return installs > 0;
}

export function glErrorTraceEntries(): readonly GlErrorTraceEntry[] {
  return entries;
}

/** Report lines for the newest recorded failures. */
export function formatGlErrorTrace(limit = 8): string[] {
  const withState = [...entries].reverse().find((entry) => entry.state);
  const shown = entries.slice(-limit);
  // The first failing draw's state is the diagnostic; keep it even when newer entries push it out.
  if (withState && !shown.includes(withState)) shown.unshift(withState);
  return shown.flatMap((entry) => [
    `${new Date(entry.time).toISOString().slice(11, 19)} ${entry.call}(${entry.args}) → ${entry.code} ${CODE_NAMES[entry.code] ?? ""}`.trimEnd(),
    `  after: ${entry.before.join(", ") || "-"}`,
    ...entry.stack.slice(0, 4).map((frame) => `  at ${frame.slice(0, 160)}`),
    ...(entry.state ?? []).map((line) => `  state: ${line}`),
  ]);
}

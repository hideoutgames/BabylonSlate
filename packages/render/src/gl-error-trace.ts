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
}

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

function wrap(proto: object): () => void {
  const originals = new Map<string, (...args: unknown[]) => unknown>();
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
  return entries.slice(-limit).flatMap((entry) => [
    `${new Date(entry.time).toISOString().slice(11, 19)} ${entry.call}(${entry.args}) → ${entry.code} ${CODE_NAMES[entry.code] ?? ""}`.trimEnd(),
    `  after: ${entry.before.join(", ") || "-"}`,
    ...entry.stack.slice(0, 4).map((frame) => `  at ${frame.slice(0, 160)}`),
  ]);
}

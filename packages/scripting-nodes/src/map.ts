import {
  pin,
  type NodeDefinition,
  EXEC,
  INT,
  BOOL,
  arrayOf,
  mapOf,
  type PinType,
  defaultValueLiteral,
} from "@haptic/scripting";
import { hoistCowHelpers } from "./cow-helpers";
import { hoistedCall } from "./hoisted-helper";

const K: PinType = { kind: "resolvingWildcard", group: "K" };
const V: PinType = { kind: "resolvingWildcard", group: "V" };

/** The most item inputs a Make Array node, or key and value pairs a Make Map node, can have. */
export const MAKE_CONTAINER_MAX_COUNT = 32;
/** Key and value pairs of a new Make Map node, and of one whose `count` is missing. */
export const MAKE_MAP_DEFAULT_PAIRS = 1;

/** Make Map pairs: a whole `count` from 0 to {@link MAKE_CONTAINER_MAX_COUNT}; {@link MAKE_MAP_DEFAULT_PAIRS} when it is missing, none when it is not a number. */
export function makeMapPairCount(properties: Record<string, unknown>): number {
  const raw = Number(properties.count ?? MAKE_MAP_DEFAULT_PAIRS);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(MAKE_CONTAINER_MAX_COUNT, Math.floor(raw)));
}

/** Pin kinds whose runtime values are plain data objects, compared by value. */
const VALUE_KEY_KINDS = new Set<PinType["kind"]>([
  "vec2",
  "vec3",
  "vec4",
  "rotator",
  "quat",
  "color",
  "transform",
  "structRef",
]);

/**
 * Module helpers for values compared by value, hoisted once into a module that needs them.
 *
 * `__valueEquals(a, b)` is recursive structural equality for plain data. It walks own enumerable
 * keys with `for..in`, so a comparison allocates no key arrays, and settles the counts before
 * recursing. A Map has no enumerable keys, so Map-typed Structure fields are compared entry by
 * entry, a key matching by identity first and by value otherwise.
 *
 * `__storedKey(m, k)` returns the key stored in `m` that equals `k` in O(1) amortized time via a
 * per-Map canonical structural key index (`__vkIndex`), falling back cleanly to linear scan for
 * unindexable keys (`NaN`, nested `Map`, non-plain objects). `__valueIndexOf(l, v)` is the
 * value-type counterpart of `indexOf`.
 */
export const VALUE_HELPERS =
  "var __valueHas=Object.prototype.hasOwnProperty,__valueEquals=(a,b)=>{if(a===b)return true;" +
  "if(a===null||b===null||typeof a!==\"object\"||typeof b!==\"object\")return false;" +
  "if(a instanceof Map||b instanceof Map){if(!(a instanceof Map&&b instanceof Map)||a.size!==b.size)return false;" +
  "for(const [k,v] of a){if(b.has(k)){if(!__valueEquals(v,b.get(k)))return false;continue;}" +
  "let f=false;for(const [o,w] of b)if(__valueEquals(k,o)){f=__valueEquals(v,w);break;}if(!f)return false;}return true;}" +
  "let c=0;for(const n in a)if(__valueHas.call(a,n))c++;" +
  "for(const n in b)if(__valueHas.call(b,n))c--;" +
  "if(c!==0)return false;" +
  "for(const n in a)if(__valueHas.call(a,n)&&!(__valueHas.call(b,n)&&__valueEquals(a[n],b[n])))return false;" +
  "return true;}," +
  "__vkIndex=new WeakMap()," +
  "__valueKey=(v,d=0)=>{if(d>16)return null;if(v===null)return \"N\";const t=typeof v;" +
  "if(t===\"number\")return Number.isNaN(v)?null:(v===0?\"n0\":\"n\"+v);" +
  "if(t===\"string\")return \"s\"+v.length+\":\"+v;" +
  "if(t===\"boolean\")return v?\"T\":\"F\";if(t===\"undefined\")return \"U\";" +
  "if(t!==\"object\"||v instanceof Map)return null;" +
  "if(Array.isArray(v)){let s=\"A\"+v.length+\"[\";for(let i=0;i<v.length;i++){const e=__valueKey(v[i],d+1);if(e===null)return null;s+=e+\",\";}return s+\"]\";}" +
  "const p=Object.getPrototypeOf(v);if(p!==Object.prototype&&p!==null)return null;" +
  "const ks=Object.keys(v);" +
  "if(ks.length===3&&\"x\"in v&&\"y\"in v&&\"z\"in v&&typeof v.x===\"number\"&&typeof v.y===\"number\"&&typeof v.z===\"number\")" +
  "{if(Number.isNaN(v.x)||Number.isNaN(v.y)||Number.isNaN(v.z))return null;return \"v3:\"+(v.x===0?0:v.x)+\",\"+(v.y===0?0:v.y)+\",\"+(v.z===0?0:v.z);}" +
  "if(ks.length===2&&\"x\"in v&&\"y\"in v&&typeof v.x===\"number\"&&typeof v.y===\"number\")" +
  "{if(Number.isNaN(v.x)||Number.isNaN(v.y))return null;return \"v2:\"+(v.x===0?0:v.x)+\",\"+(v.y===0?0:v.y);}" +
  "if(ks.length===4&&\"x\"in v&&\"y\"in v&&\"z\"in v&&\"w\"in v&&typeof v.x===\"number\"&&typeof v.y===\"number\"&&typeof v.z===\"number\"&&typeof v.w===\"number\")" +
  "{if(Number.isNaN(v.x)||Number.isNaN(v.y)||Number.isNaN(v.z)||Number.isNaN(v.w))return null;return \"v4:\"+(v.x===0?0:v.x)+\",\"+(v.y===0?0:v.y)+\",\"+(v.z===0?0:v.z)+\",\"+(v.w===0?0:v.w);}" +
  "ks.sort();let s=\"O\"+ks.length+\"{\";for(let i=0;i<ks.length;i++){const kn=ks[i],e=__valueKey(v[kn],d+1);if(e===null)return null;s+=kn.length+\":\"+kn+\"=\"+e+\";\";}return s+\"}\";}," +
  "__syncVk=(m)=>{let idx=__vkIndex.get(m);if(!idx||idx.size!==m.size){const keys=new Map();let all=true;" +
  "for(const e of m.keys()){const ck=__valueKey(e);if(ck!==null)keys.set(ck,e);else all=false;}idx={size:m.size,keys,all};__vkIndex.set(m,idx);}return idx;}," +
  "__storedKey=(m,k)=>{if(k===null||typeof k!==\"object\"||m.has(k))return k;const ck=__valueKey(k);" +
  "if(ck!==null){const idx=__syncVk(m),hit=idx.keys.get(ck);if(hit!==undefined){if(m.has(hit)&&__valueEquals(hit,k))return hit;idx.keys.delete(ck);}if(idx.all)return k;}" +
  "for(const e of m.keys())if(__valueEquals(e,k))return e;return k;}," +
  "__mapSetVal=(m,k,v)=>{const s=__storedKey(m,k);m.set(s,v);const idx=__vkIndex.get(m);" +
  "if(idx){if(s===k){const ck=__valueKey(k);if(ck!==null)idx.keys.set(ck,k);else idx.all=false;}idx.size=m.size;}return m;}," +
  "__mapDelVal=(m,k)=>{const s=__storedKey(m,k),del=m.delete(s),idx=__vkIndex.get(m);" +
  "if(idx&&del){const ck=__valueKey(s);if(ck!==null)idx.keys.delete(ck);idx.size=m.size;}return del;}," +
  "__valueIndexOf=(l,v)=>{if(!l)return -1;for(let i=0;i<l.length;i++)if(__valueEquals(l[i],v))return i;return -1;};";

const MAP_MISS_SENTINEL = "var __MAP_MISS={};";

type Codegen = Parameters<NodeDefinition["codegen"]>[0];

/** The name of a value helper (see `VALUE_HELPERS`), hoisting the helpers into the module. */
function valueHelper(ctx: Codegen, name: "__storedKey" | "__valueIndexOf" | "__mapSetVal" | "__mapDelVal"): string {
  ctx.hoist(VALUE_HELPERS);
  return name;
}

/** `(l, v) => index` of the first array element structurally equal to `v`, or -1. */
export function valueIndexOf(ctx: Codegen): string {
  return valueHelper(ctx, "__valueIndexOf");
}

/** True when the (resolved) pin carries a value type compared by value. */
export function hasValueTypePin(
  ctx: Parameters<NodeDefinition["codegen"]>[0],
  pinId: string,
): boolean {
  const keyPin = ctx.node.pins.find((entry) => entry.id === pinId);
  return keyPin !== undefined && VALUE_KEY_KINDS.has(keyPin.type.kind);
}

function valueFallback(ctx: Parameters<NodeDefinition["codegen"]>[0]) {
  const outPin = ctx.node.pins.find((entry) => entry.id === "out");
  return defaultValueLiteral(outPin?.type ?? V);
}

function mapCloneOrCow(ctx: Codegen, mapExpr: string): string {
  hoistCowHelpers(ctx);
  if (ctx.isLinearSelfUpdate) {
    return hoistedCall(ctx, "__map_cow", "m", "(m != null && __cowUnique.has(m) ? m : __cowOwn(m != null ? new Map(m) : new Map()))", [mapExpr]);
  }
  return hoistedCall(ctx, "__map_clone", "m", "__cowOwn(m != null ? new Map(m) : new Map())", [mapExpr]);
}

export const mapNodes: NodeDefinition[] = [
  {
    id: "map.make",
    title: "Make Map",
    category: "map",
    pure: true,
    pins: (properties) => {
      const count = makeMapPairCount(properties);
      const pins = [];
      for (let i = 0; i < count; i++) {
        pins.push(pin(`key${i}`, `Key ${i}`, "in", K));
        pins.push(pin(`value${i}`, `Value ${i}`, "in", V));
      }
      pins.push(pin("out", "Out", "out", mapOf(K, V)));
      return pins;
    },
    codegen: (ctx) => {
      hoistCowHelpers(ctx);
      const count = makeMapPairCount(ctx.node.properties);
      const pairs: string[] = [];
      for (let i = 0; i < count; i++) {
        pairs.push(`[${ctx.input(`key${i}`)}, ${ctx.input(`value${i}`)}]`);
      }
      const entries = `[${pairs.join(", ")}]`;
      if (!hasValueTypePin(ctx, "key0")) return { out: `__cowOwn(new Map(${entries}))` };
      valueHelper(ctx, "__mapSetVal");
      return {
        out: hoistedCall(
          ctx,
          "__map_make_val",
          "p",
          "{ const m = __cowOwn(new Map()); for (let i = 0; i < p.length; i++) __mapSetVal(m, p[i][0], p[i][1]); return m; }",
          [entries],
        ),
      };
    },
  },
  {
    id: "map.get",
    title: "Get Map Value",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "Map", "in", mapOf(K, V)),
      pin("key", "Key", "in", K),
      pin("out", "Value", "out", V),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const map = ctx.input("map");
      const key = ctx.input("key");
      const fallback = valueFallback(ctx);
      ctx.hoist(MAP_MISS_SENTINEL);
      let lookup: string;
      if (hasValueTypePin(ctx, "key")) {
        valueHelper(ctx, "__storedKey");
        lookup = hoistedCall(
          ctx,
          "__map_get_val",
          "m, k",
          "{ if (m == null) return __MAP_MISS; const s = __storedKey(m, k); return m.has(s) ? m.get(s) : __MAP_MISS; }",
          [map, key],
        );
      } else {
        lookup = hoistedCall(
          ctx,
          "__map_get",
          "m, k",
          "(m != null && m.has(k) ? m.get(k) : __MAP_MISS)",
          [map, key],
        );
      }
      const result = ctx.shared?.(lookup) ?? lookup;
      const out = ctx.allocTemp
        ? (() => {
            const t = ctx.allocTemp!();
            return `(${t} = (${result}), ${t} !== __MAP_MISS ? ${t} : ${fallback})`;
          })()
        : hoistedCall(ctx, "__map_or", "v, d", "(v !== __MAP_MISS ? v : d)", [result, fallback]);
      return {
        found: `((${result}) !== __MAP_MISS)`,
        out,
      };
    },
  },
  {
    id: "map.set",
    title: "Set Map Value",
    category: "map",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("map", "Map", "in", mapOf(K, V)),
      pin("key", "Key", "in", K),
      pin("value", "Value", "in", V),
      pin("out", "Out", "out", mapOf(K, V)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      const mapExpr = mapCloneOrCow(ctx, ctx.input("map"));
      const key = ctx.input("key");
      const value = ctx.input("value");
      if (hasValueTypePin(ctx, "key")) {
        const setVal = valueHelper(ctx, "__mapSetVal");
        ctx.emit(`${out} = ${mapExpr}; ${setVal}(${out}, ${key}, ${value});`);
      } else {
        ctx.emit(`${out} = ${mapExpr}; ${out}.set(${key}, ${value});`);
      }
    },
  },
  {
    id: "map.has",
    title: "Has Map Key",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "Map", "in", mapOf(K, V)),
      pin("key", "Key", "in", K),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => {
      const map = ctx.input("map");
      const key = ctx.input("key");
      if (hasValueTypePin(ctx, "key")) {
        valueHelper(ctx, "__storedKey");
        return {
          out: hoistedCall(ctx, "__map_has_val", "m, k", "(m != null && m.has(__storedKey(m, k)))", [map, key]),
        };
      }
      return {
        out: hoistedCall(ctx, "__map_has", "m, k", "(m != null && m.has(k))", [map, key]),
      };
    },
  },
  {
    id: "map.remove",
    title: "Remove Map Key",
    category: "map",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("map", "Map", "in", mapOf(K, V)),
      pin("key", "Key", "in", K),
      pin("out", "Out", "out", mapOf(K, V)),
      pin("removed", "Removed", "out", BOOL),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      const removed = ctx.output("removed");
      const mapExpr = mapCloneOrCow(ctx, ctx.input("map"));
      const key = ctx.input("key");
      ctx.emit(`${out} = ${mapExpr};`);
      if (hasValueTypePin(ctx, "key")) {
        const delVal = valueHelper(ctx, "__mapDelVal");
        ctx.emit(`${removed} = ${delVal}(${out}, ${key});`);
      } else {
        ctx.emit(`${removed} = ${out}.delete(${key});`);
      }
    },
  },
  {
    id: "map.size",
    title: "Get Map Size",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "Map", "in", mapOf(K, V)),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("map")})?.size ?? 0)`,
    }),
  },
  {
    id: "map.isEmpty",
    title: "Is Map Empty",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "Map", "in", mapOf(K, V)),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(((${ctx.input("map")})?.size ?? 0) === 0)`,
    }),
  },
  {
    id: "map.clear",
    title: "Clear Map",
    category: "map",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("map", "Map", "in", mapOf(K, V)),
      pin("out", "Out", "out", mapOf(K, V)),
    ],
    codegen: (ctx) => {
      hoistCowHelpers(ctx);
      ctx.emit(`${ctx.output("out")} = __cowOwn(new Map());`);
    },
  },
  {
    id: "map.keys",
    title: "Get Map Keys",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "Map", "in", mapOf(K, V)),
      pin("out", "Out", "out", arrayOf(K)),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(ctx, "__map_keys", "m", "(m != null ? [...m.keys()] : [])", [ctx.input("map")]),
    }),
  },
  {
    id: "map.values",
    title: "Get Map Values",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "Map", "in", mapOf(K, V)),
      pin("out", "Out", "out", arrayOf(V)),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(ctx, "__map_values", "m", "(m != null ? [...m.values()] : [])", [ctx.input("map")]),
    }),
  },
  {
    id: "map.break",
    title: "Break Map",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "Map", "in", mapOf(K, V)),
      pin("keys", "Keys", "out", arrayOf(K)),
      pin("values", "Values", "out", arrayOf(V)),
    ],
    codegen: (ctx) => {
      // One walk of the entries per statement serves both outputs.
      const walk = hoistedCall(ctx, "__map_entries", "m", "(m != null ? [...m.entries()] : [])", [ctx.input("map")]);
      const entries = ctx.shared?.(walk) ?? walk;
      return {
        keys: hoistedCall(ctx, "__map_col0", "e", "{ const r = new Array(e.length); for (let i = 0; i < e.length; i++) r[i] = e[i][0]; return r; }", [entries]),
        values: hoistedCall(ctx, "__map_col1", "e", "{ const r = new Array(e.length); for (let i = 0; i < e.length; i++) r[i] = e[i][1]; return r; }", [entries]),
      };
    },
  },
];

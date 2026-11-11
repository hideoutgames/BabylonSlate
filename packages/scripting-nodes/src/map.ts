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

const K: PinType = { kind: "resolvingWildcard", group: "K" };
const V: PinType = { kind: "resolvingWildcard", group: "V" };

function pairCount(properties: Record<string, unknown>): number {
  const raw = Number(properties.count ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(32, Math.floor(raw)));
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
 * `__storedKey(m, k)` returns the key stored in `m` that equals `k`: native `Map` compares objects
 * by reference, and each Vector / struct read yields a new object, so value-type keys would
 * otherwise never match. `__valueIndexOf(l, v)` is the value-type counterpart of `indexOf`.
 */
export const VALUE_HELPERS =
  "const __valueHas=Object.prototype.hasOwnProperty,__valueEquals=(a,b)=>{if(a===b)return true;" +
  "if(a===null||b===null||typeof a!==\"object\"||typeof b!==\"object\")return false;" +
  "if(a instanceof Map||b instanceof Map){if(!(a instanceof Map&&b instanceof Map)||a.size!==b.size)return false;" +
  "for(const [k,v] of a){if(b.has(k)){if(!__valueEquals(v,b.get(k)))return false;continue;}" +
  "let f=false;for(const [o,w] of b)if(__valueEquals(k,o)){f=__valueEquals(v,w);break;}if(!f)return false;}return true;}" +
  "let c=0;for(const n in a)if(__valueHas.call(a,n))c++;" +
  "for(const n in b)if(__valueHas.call(b,n))c--;" +
  "if(c!==0)return false;" +
  "for(const n in a)if(__valueHas.call(a,n)&&!(__valueHas.call(b,n)&&__valueEquals(a[n],b[n])))return false;" +
  "return true;}," +
  "__storedKey=(m,k)=>{if(k===null||typeof k!==\"object\"||m.has(k))return k;" +
  "for(const e of m.keys())if(__valueEquals(e,k))return e;return k;}," +
  "__valueIndexOf=(l,v)=>{for(let i=0;i<l.length;i++)if(__valueEquals(l[i],v))return i;return -1;};";

type Codegen = Parameters<NodeDefinition["codegen"]>[0];

/** The name of a value helper (see `VALUE_HELPERS`), hoisting the helpers into the module. */
function valueHelper(ctx: Codegen, name: "__storedKey" | "__valueIndexOf"): string {
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

/** Expression for the key to use against map expression `map`. */
function storedKey(
  ctx: Parameters<NodeDefinition["codegen"]>[0],
  pinId: string,
  map: string,
  key: string,
): string {
  return hasValueTypePin(ctx, pinId) ? `${valueHelper(ctx, "__storedKey")}(${map},${key})` : key;
}

function valueFallback(ctx: Parameters<NodeDefinition["codegen"]>[0]) {
  const outPin = ctx.node.pins.find((entry) => entry.id === "out");
  return defaultValueLiteral(outPin?.type ?? V);
}

export const mapNodes: NodeDefinition[] = [
  {
    id: "map.make",
    title: "Make Map",
    category: "map",
    pure: true,
    pins: (properties) => {
      const count = pairCount(properties);
      const pins = [];
      for (let i = 0; i < count; i++) {
        pins.push(pin(`key${i}`, `Key ${i}`, "in", K));
        pins.push(pin(`value${i}`, `Value ${i}`, "in", V));
      }
      pins.push(pin("out", "Out", "out", mapOf(K, V)));
      return pins;
    },
    codegen: (ctx) => {
      const count = pairCount(ctx.node.properties);
      const pairs: string[] = [];
      for (let i = 0; i < count; i++) {
        pairs.push(`[${ctx.input(`key${i}`)}, ${ctx.input(`value${i}`)}]`);
      }
      const entries = `[${pairs.join(", ")}]`;
      if (!hasValueTypePin(ctx, "key0")) return { out: `new Map(${entries})` };
      return {
        out: `((p)=>{const m=new Map();for(const [k,v] of p)m.set(${valueHelper(ctx, "__storedKey")}(m,k),v);return m;})(${entries})`,
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
      const k = storedKey(ctx, "key", "t", "k");
      // One lookup per statement serves both Found and Value.
      const lookup = `((m,k)=>{const t=m??new Map();const s=${k};return t.has(s)?{found:true,value:t.get(s)}:{found:false};})(${map},${key})`;
      const result = ctx.shared?.(lookup) ?? lookup;
      return {
        found: `(${result}.found)`,
        out: `((r,d)=>r.found?r.value:d)(${result},${fallback})`,
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
      ctx.emit(
        `${out} = new Map(${ctx.input("map")}??[]); ${out}.set(${storedKey(ctx, "key", out, ctx.input("key"))}, ${ctx.input("value")});`,
      );
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
    codegen: (ctx) => ({
      out: `((m,k)=>{const t=m??new Map();return t.has(${storedKey(ctx, "key", "t", "k")});})(${ctx.input("map")},${ctx.input("key")})`,
    }),
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
      ctx.emit(`${out} = new Map(${ctx.input("map")}??[]);`);
      ctx.emit(`${removed} = ${out}.delete(${storedKey(ctx, "key", out, ctx.input("key"))});`);
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
      out: `((${ctx.input("map")})??new Map()).size`,
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
      out: `(((${ctx.input("map")})??new Map()).size===0)`,
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
      ctx.emit(`${ctx.output("out")} = new Map();`);
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
      out: `[...((${ctx.input("map")})??new Map()).keys()]`,
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
      out: `[...((${ctx.input("map")})??new Map()).values()]`,
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
      const walk = `[...((${ctx.input("map")})??new Map()).entries()]`;
      const entries = ctx.shared?.(walk) ?? walk;
      return {
        keys: `(${entries}.map((e)=>e[0]))`,
        values: `(${entries}.map((e)=>e[1]))`,
      };
    },
  },
];

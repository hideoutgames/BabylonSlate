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
} from "@babylonslate/scripting";

const K: PinType = { kind: "resolvingWildcard", group: "K" };
const V: PinType = { kind: "resolvingWildcard", group: "V" };

function pairCount(properties: Record<string, unknown>): number {
  const raw = Number(properties.count ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(32, Math.floor(raw)));
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
      return { out: `new Map([${pairs.join(", ")}])` };
    },
  },
  {
    id: "map.get",
    title: "Map Get",
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
      return {
        found: `((m,k)=>(m??new Map()).has(k))(${map},${key})`,
        out: `((m,k,d)=>{const t=m??new Map();return t.has(k)?t.get(k):d;})(${map},${key},${fallback})`,
      };
    },
  },
  {
    id: "map.set",
    title: "Map Set",
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
        `${out} = new Map(${ctx.input("map")}??[]); ${out}.set(${ctx.input("key")}, ${ctx.input("value")});`,
      );
    },
  },
  {
    id: "map.has",
    title: "Map Has",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "Map", "in", mapOf(K, V)),
      pin("key", "Key", "in", K),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("map")})??new Map()).has(${ctx.input("key")})`,
    }),
  },
  {
    id: "map.remove",
    title: "Map Remove",
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
      ctx.emit(`${removed} = ${out}.delete(${ctx.input("key")});`);
    },
  },
  {
    id: "map.size",
    title: "Map Size",
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
    title: "Is Empty",
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
    title: "Map Clear",
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
    title: "Map Keys",
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
    title: "Map Values",
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
      const map = ctx.input("map");
      return {
        keys: `((m)=>{const k=[]; for (const e of (m??new Map()).entries()) k.push(e[0]); return k;})(${map})`,
        values: `((m)=>{const v=[]; for (const e of (m??new Map()).entries()) v.push(e[1]); return v;})(${map})`,
      };
    },
  },
];

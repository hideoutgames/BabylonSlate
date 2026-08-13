import {
  pin,
  type NodeDefinition,
  EXEC,
  INT,
  BOOL,
  arrayOf,
  mapOf,
  type PinType,
} from "@babylonslate/scripting";

const K: PinType = { kind: "resolvingWildcard", group: "K" };
const V: PinType = { kind: "resolvingWildcard", group: "V" };

export const mapNodes: NodeDefinition[] = [
  {
    id: "map.get",
    title: "Map Get",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "map", "in", mapOf(K, V)),
      pin("key", "key", "in", K),
      pin("out", "out", "out", V),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("map")}).get(${ctx.input("key")})`,
    }),
  },
  {
    id: "map.set",
    title: "Map Set",
    category: "map",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("map", "map", "in", mapOf(K, V)),
      pin("key", "key", "in", K),
      pin("value", "value", "in", V),
      pin("out", "out", "out", mapOf(K, V)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = new Map(${ctx.input("map")}); ${out}.set(${ctx.input("key")}, ${ctx.input("value")});`,
      );
    },
  },
  {
    id: "map.has",
    title: "Map Has",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "map", "in", mapOf(K, V)),
      pin("key", "key", "in", K),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("map")}).has(${ctx.input("key")})`,
    }),
  },
  {
    id: "map.remove",
    title: "Map Remove",
    category: "map",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("map", "map", "in", mapOf(K, V)),
      pin("key", "key", "in", K),
      pin("out", "out", "out", mapOf(K, V)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = new Map(${ctx.input("map")}); ${out}.delete(${ctx.input("key")});`,
      );
    },
  },
  {
    id: "map.size",
    title: "Map Size",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "map", "in", mapOf(K, V)),
      pin("out", "out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `(${ctx.input("map")}).size` }),
  },
  {
    id: "map.keys",
    title: "Map Keys",
    category: "map",
    pure: true,
    pins: () => [
      pin("map", "map", "in", mapOf(K, V)),
      pin("out", "out", "out", arrayOf(K)),
    ],
    codegen: (ctx) => ({
      out: `[...(${ctx.input("map")}).keys()]`,
    }),
  },
];

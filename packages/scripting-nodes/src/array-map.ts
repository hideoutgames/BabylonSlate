import {
  pin,
  type NodeDefinition,
  EXEC,
  INT,
  BOOL,
  RESOLVING_WILDCARD,
  arrayOf,
  defaultValueLiteral,
} from "@haptic/scripting";
import { hoistCowHelpers } from "./cow-helpers";
import { hoistedCall } from "./hoisted-helper";
import { hasValueTypePin, MAKE_CONTAINER_MAX_COUNT, valueIndexOf } from "./map";

const T = RESOLVING_WILDCARD;
const ARR_MISS_SENTINEL = "var __ARR_MISS={};";

type Ctx = Parameters<NodeDefinition["codegen"]>[0];

/**
 * Index of `item` in `array`. Vector, rotator, color, transform and struct
 * reads are new objects each time, so those items match by value.
 */
function itemIndexExpr(ctx: Ctx, array: string, item: string): string {
  return hasValueTypePin(ctx, "item")
    ? `${valueIndexOf(ctx)}(${array},${item})`
    : hoistedCall(ctx, "__arr_find", "a, v", "(a != null ? a.indexOf(v) : -1)", [array, item]);
}

function outFallback(ctx: Ctx, pinId = "out"): string {
  const outPin = ctx.node.pins.find((entry) => entry.id === pinId);
  return defaultValueLiteral(outPin?.type ?? RESOLVING_WILDCARD);
}

function lazyOrFallback(ctx: Ctx, lookupExpr: string, fallback: string): string {
  ctx.hoist(ARR_MISS_SENTINEL);
  if (ctx.allocTemp) {
    const t = ctx.allocTemp();
    return `(${t} = (${lookupExpr}), ${t} !== __ARR_MISS ? ${t} : ${fallback})`;
  }
  return hoistedCall(ctx, "__arr_or", "v, d", "(v !== __ARR_MISS ? v : d)", [lookupExpr, fallback]);
}

function arrayCloneOrCow(ctx: Ctx, arrayExpr: string): string {
  hoistCowHelpers(ctx);
  if (ctx.isLinearSelfUpdate) {
    return hoistedCall(ctx, "__arr_cow", "a", "(a != null && __cowUnique.has(a) ? a : __cowOwn(a != null ? a.slice() : []))", [arrayExpr]);
  }
  return hoistedCall(ctx, "__arr_clone", "a", "__cowOwn(a != null ? a.slice() : [])", [arrayExpr]);
}

/** Item inputs of a new Make Array node, and of one whose `count` is missing. */
export const MAKE_ARRAY_DEFAULT_ITEMS = 1;

/** Make Array items: a whole `count` from 0 to {@link MAKE_CONTAINER_MAX_COUNT}; {@link MAKE_ARRAY_DEFAULT_ITEMS} when it is missing, none when it is not a number. */
export function makeArrayItemCount(properties: Record<string, unknown>): number {
  const raw = Number(properties.count ?? MAKE_ARRAY_DEFAULT_ITEMS);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(MAKE_CONTAINER_MAX_COUNT, Math.floor(raw)));
}

export const arrayMapNodes: NodeDefinition[] = [
  {
    id: "array.make",
    title: "Make Array",
    category: "array",
    pure: true,
    pins: (properties) => {
      const count = makeArrayItemCount(properties);
      const pins = [];
      for (let i = 0; i < count; i++) {
        pins.push(pin(`item${i}`, `Item ${i}`, "in", T));
      }
      pins.push(pin("out", "Out", "out", arrayOf(T)));
      return pins;
    },
    codegen: (ctx) => {
      hoistCowHelpers(ctx);
      const count = makeArrayItemCount(ctx.node.properties);
      const items: string[] = [];
      for (let i = 0; i < count; i++) {
        items.push(ctx.input(`item${i}`));
      }
      return { out: `__cowOwn([${items.join(", ")}])` };
    },
  },
  {
    id: "array.get",
    title: "Get Array Item",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("out", "Out", "out", T),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const array = ctx.input("array");
      const index = ctx.input("index");
      const fallback = outFallback(ctx);
      ctx.hoist(ARR_MISS_SENTINEL);
      const lookup = hoistedCall(
        ctx,
        "__arr_at",
        "a, i",
        "(a != null && Number.isInteger(i) && i >= 0 && i < a.length ? a[i] : __ARR_MISS)",
        [array, index],
      );
      const result = ctx.shared?.(lookup) ?? lookup;
      return {
        success: `((${result}) !== __ARR_MISS)`,
        out: lazyOrFallback(ctx, result, fallback),
      };
    },
  },
  {
    id: "array.length",
    title: "Get Array Length",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `((${ctx.input("array")})?.length ?? 0)` }),
  },
  {
    id: "array.isEmpty",
    title: "Is Array Empty",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(((${ctx.input("array")})?.length ?? 0) === 0)`,
    }),
  },
  {
    id: "array.lastIndex",
    title: "Get Last Array Index",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({
      out: `(((${ctx.input("array")})?.length ?? 0) - 1)`,
    }),
  },
  {
    id: "array.isValidIndex",
    title: "Is Valid Array Index",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(
        ctx,
        "__arr_valid",
        "a, i",
        "(a != null && Number.isInteger(i) && i >= 0 && i < a.length)",
        [ctx.input("array"), ctx.input("index")],
      ),
    }),
  },
  {
    id: "array.contains",
    title: "Has Array Item",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => {
      const array = ctx.input("array");
      const item = ctx.input("item");
      return {
        out: hasValueTypePin(ctx, "item")
          ? `(${itemIndexExpr(ctx, array, item)} >= 0)`
          : hoistedCall(ctx, "__arr_has", "a, v", "(a != null && a.includes(v))", [array, item]),
      };
    },
  },
  {
    id: "array.find",
    title: "Find Array Item",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({
      out: itemIndexExpr(ctx, ctx.input("array"), ctx.input("item")),
    }),
  },
  {
    id: "array.append",
    title: "Append Array Item",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      hoistCowHelpers(ctx);
      const args = [ctx.input("array"), ctx.input("item")];
      if (ctx.isLinearSelfUpdate) {
        return {
          out: hoistedCall(
            ctx,
            "__arr_append_cow",
            "a, v",
            "{ if (a != null && __cowUnique.has(a)) { a.push(v); return a; } const r = a != null ? a.slice() : []; r.push(v); return __cowOwn(r); }",
            args,
          ),
        };
      }
      return {
        out: hoistedCall(
          ctx,
          "__arr_append",
          "a, v",
          "{ const r = a != null ? a.slice() : []; r.push(v); return __cowOwn(r); }",
          args,
        ),
      };
    },
  },
  {
    id: "array.appendArray",
    title: "Append Array",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("other", "Other", "in", arrayOf(T)),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      hoistCowHelpers(ctx);
      const args = [ctx.input("array"), ctx.input("other")];
      if (ctx.isLinearSelfUpdate) {
        return {
          out: hoistedCall(
            ctx,
            "__arr_concat_cow",
            "a, b",
            "{ const r = a != null && __cowUnique.has(a) ? a : __cowOwn(a != null ? a.slice() : []); if (b != null) { const n = b.length; for (let i = 0; i < n; i++) r.push(b[i]); } return r; }",
            args,
          ),
        };
      }
      return {
        out: hoistedCall(
          ctx,
          "__arr_concat",
          "a, b",
          "{ const r = a != null ? a.slice() : []; if (b != null) { const n = b.length; for (let i = 0; i < n; i++) r.push(b[i]); } return __cowOwn(r); }",
          args,
        ),
      };
    },
  },
  {
    id: "array.set",
    title: "Set Array Item",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", arrayOf(T)),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      const success = ctx.output("success");
      const array = arrayCloneOrCow(ctx, ctx.input("array"));
      const index = ctx.input("index");
      const item = ctx.input("item");
      ctx.emit(`${out} = ${array};`);
      // Read the index once so the bounds check and the write use one value.
      ctx.emit(
        `{ const __i = ${index}; ${success} = Number.isInteger(__i)&&__i>=0&&__i<${out}.length; if (${success}) { ${out}[__i] = ${item}; } }`,
      );
    },
  },
  {
    id: "array.insert",
    title: "Insert Array Item",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", arrayOf(T)),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      const success = ctx.output("success");
      const index = ctx.input("index");
      ctx.emit(`${out} = ${arrayCloneOrCow(ctx, ctx.input("array"))};`);
      // Read the index once. Index may be the length, which appends; anything else outside the array inserts nothing.
      ctx.emit(
        `{ const __i = ${index}; ${success} = Number.isInteger(__i)&&__i>=0&&__i<=${out}.length; if (${success}) { ${out}.splice(__i, 0, ${ctx.input("item")}); } }`,
      );
    },
  },
  {
    id: "array.removeIndex",
    title: "Remove Array Item At",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("out", "Out", "out", arrayOf(T)),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      const success = ctx.output("success");
      const index = ctx.input("index");
      ctx.emit(`${out} = ${arrayCloneOrCow(ctx, ctx.input("array"))};`);
      // Read the index once so the bounds check and the removal use one value.
      ctx.emit(
        `{ const __i = ${index}; ${success} = Number.isInteger(__i)&&__i>=0&&__i<${out}.length; if (${success}) { ${out}.splice(__i, 1); } }`,
      );
    },
  },
  {
    id: "array.removeItem",
    title: "Remove Array Item",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", arrayOf(T)),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      const success = ctx.output("success");
      const item = ctx.input("item");
      ctx.emit(`${out} = ${arrayCloneOrCow(ctx, ctx.input("array"))};`);
      ctx.emit(`{ const __i = ${itemIndexExpr(ctx, out, item)}; ${success} = __i>=0; if (${success}) { ${out}.splice(__i, 1); } }`);
    },
  },
  {
    id: "array.clear",
    title: "Clear Array",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      hoistCowHelpers(ctx);
      ctx.emit(`${ctx.output("out")} = __cowOwn([]);`);
    },
  },
  {
    id: "array.reverse",
    title: "Reverse Array",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      hoistCowHelpers(ctx);
      return {
        out: hoistedCall(ctx, "__arr_reverse", "a", "__cowOwn(a != null ? a.slice().reverse() : [])", [ctx.input("array")]),
      };
    },
  },
  {
    id: "array.slice",
    title: "Slice Array",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("start", "Start", "in", INT),
      pin("end", "End", "in", INT),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      hoistCowHelpers(ctx);
      return {
        out: hoistedCall(ctx, "__arr_slice", "a, s, e", "__cowOwn(a != null ? a.slice(s, e) : [])", [ctx.input("array"), ctx.input("start"), ctx.input("end")]),
      };
    },
  },
  {
    id: "array.first",
    title: "Get First Array Item",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", T),
    ],
    codegen: (ctx) => {
      const fallback = outFallback(ctx);
      ctx.hoist(ARR_MISS_SENTINEL);
      const lookup = hoistedCall(ctx, "__arr_first", "a", "(a != null && a.length > 0 ? a[0] : __ARR_MISS)", [ctx.input("array")]);
      return { out: lazyOrFallback(ctx, lookup, fallback) };
    },
  },
  {
    id: "array.last",
    title: "Get Last Array Item",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", T),
    ],
    codegen: (ctx) => {
      const fallback = outFallback(ctx);
      ctx.hoist(ARR_MISS_SENTINEL);
      const lookup = hoistedCall(ctx, "__arr_last", "a", "(a != null && a.length > 0 ? a[a.length - 1] : __ARR_MISS)", [ctx.input("array")]);
      return { out: lazyOrFallback(ctx, lookup, fallback) };
    },
  },
];

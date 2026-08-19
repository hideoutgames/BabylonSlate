import {
  pin,
  type NodeDefinition,
  EXEC,
  INT,
  BOOL,
  RESOLVING_WILDCARD,
  arrayOf,
  defaultValueLiteral,
} from "@babylonslate/scripting";

const T = RESOLVING_WILDCARD;

function outFallback(ctx: Parameters<NodeDefinition["codegen"]>[0], pinId = "out") {
  const outPin = ctx.node.pins.find((entry) => entry.id === pinId);
  return defaultValueLiteral(outPin?.type ?? RESOLVING_WILDCARD);
}

function makeItemCount(properties: Record<string, unknown>): number {
  const raw = Number(properties.count ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(32, Math.floor(raw)));
}

export const arrayMapNodes: NodeDefinition[] = [
  {
    id: "array.make",
    title: "Make Array",
    category: "array",
    pure: true,
    pins: (properties) => {
      const count = makeItemCount(properties);
      const pins = [];
      for (let i = 0; i < count; i++) {
        pins.push(pin(`item${i}`, `Item ${i}`, "in", T));
      }
      pins.push(pin("out", "Out", "out", arrayOf(T)));
      return pins;
    },
    codegen: (ctx) => {
      const count = makeItemCount(ctx.node.properties);
      const items: string[] = [];
      for (let i = 0; i < count; i++) {
        items.push(ctx.input(`item${i}`));
      }
      return { out: `[${items.join(", ")}]` };
    },
  },
  {
    id: "array.get",
    title: "Array Get",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("out", "Out", "out", T),
      pin("valid", "Valid", "out", BOOL),
    ],
    codegen: (ctx) => {
      const array = ctx.input("array");
      const index = ctx.input("index");
      const fallback = outFallback(ctx);
      return {
        valid: `((a,i)=>{const l=a??[];return Number.isInteger(i)&&i>=0&&i<l.length;})(${array},${index})`,
        out: `((a,i,d)=>{const l=a??[];return Number.isInteger(i)&&i>=0&&i<l.length?l[i]:d;})(${array},${index},${fallback})`,
      };
    },
  },
  {
    id: "array.getSafe",
    title: "Get Safe",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("out", "Out", "out", T),
      pin("valid", "Valid", "out", BOOL),
    ],
    codegen: (ctx) => {
      const array = ctx.input("array");
      const index = ctx.input("index");
      const fallback = outFallback(ctx);
      return {
        valid: `((a,i)=>{const l=a??[];return Number.isInteger(i)&&i>=0&&i<l.length;})(${array},${index})`,
        out: `((a,i,d)=>{const l=a??[];return Number.isInteger(i)&&i>=0&&i<l.length?l[i]:d;})(${array},${index},${fallback})`,
      };
    },
  },
  {
    id: "array.length",
    title: "Array Length",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `((${ctx.input("array")})??[]).length` }),
  },
  {
    id: "array.isEmpty",
    title: "Is Empty",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(((${ctx.input("array")})??[]).length===0)`,
    }),
  },
  {
    id: "array.lastIndex",
    title: "Last Index",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({
      out: `((a=>{const l=(a??[]).length;return l===0?-1:l-1;})(${ctx.input("array")}))`,
    }),
  },
  {
    id: "array.isValidIndex",
    title: "Is Valid Index",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((a,i)=>{const l=a??[];return Number.isInteger(i)&&i>=0&&i<l.length;})(${ctx.input("array")},${ctx.input("index")})`,
    }),
  },
  {
    id: "array.contains",
    title: "Array Contains",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("array")})??[]).includes(${ctx.input("item")})`,
    }),
  },
  {
    id: "array.find",
    title: "Find Index",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", INT),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("array")})??[]).indexOf(${ctx.input("item")})`,
    }),
  },
  {
    id: "array.append",
    title: "Append Item",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = ((${ctx.input("array")})??[]).concat([${ctx.input("item")}]);`,
      );
    },
  },
  {
    id: "array.appendArray",
    title: "Append Array",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("other", "Other", "in", arrayOf(T)),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = ((${ctx.input("array")})??[]).concat((${ctx.input("other")})??[]);`,
      );
    },
  },
  {
    id: "array.set",
    title: "Set At Index",
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
      const array = ctx.input("array");
      const index = ctx.input("index");
      const item = ctx.input("item");
      ctx.emit(`${out} = ((${array})??[]).slice();`);
      ctx.emit(
        `${success} = Number.isInteger(${index})&&${index}>=0&&${index}<${out}.length;`,
      );
      ctx.emit(`if (${success}) { ${out}[${index}] = ${item}; }`);
    },
  },
  {
    id: "array.insert",
    title: "Array Insert",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("index", "Index", "in", INT),
      pin("item", "Item", "in", T),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      const index = ctx.input("index");
      ctx.emit(`${out} = ((${ctx.input("array")})??[]).slice();`);
      ctx.emit(
        `${out}.splice((Number.isFinite(${index})?Math.max(0,${index}|0):0), 0, ${ctx.input("item")});`,
      );
    },
  },
  {
    id: "array.removeIndex",
    title: "Remove At",
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
      ctx.emit(`${out} = ((${ctx.input("array")})??[]).slice();`);
      ctx.emit(
        `${success} = Number.isInteger(${index})&&${index}>=0&&${index}<${out}.length;`,
      );
      ctx.emit(`if (${success}) { ${out}.splice(${index}, 1); }`);
    },
  },
  {
    id: "array.removeItem",
    title: "Remove Item",
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
      ctx.emit(`${out} = ((${ctx.input("array")})??[]).slice();`);
      ctx.emit(`{ const __i = ${out}.indexOf(${item}); ${success} = __i>=0; if (${success}) { ${out}.splice(__i, 1); } }`);
    },
  },
  {
    id: "array.clear",
    title: "Array Clear",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("out")} = [];`);
    },
  },
  {
    id: "array.reverse",
    title: "Array Reverse",
    category: "array",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(`${out} = ((${ctx.input("array")})??[]).slice().reverse();`);
    },
  },
  {
    id: "array.slice",
    title: "Array Slice",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("start", "Start", "in", INT),
      pin("end", "End", "in", INT),
      pin("out", "Out", "out", arrayOf(T)),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("array")})??[]).slice(${ctx.input("start")}, ${ctx.input("end")})`,
    }),
  },
  {
    id: "array.first",
    title: "Array First",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", T),
    ],
    codegen: (ctx) => {
      const fallback = outFallback(ctx);
      return {
        out: `((a,d)=>{const l=a??[];return l.length>0?l[0]:d;})(${ctx.input("array")},${fallback})`,
      };
    },
  },
  {
    id: "array.last",
    title: "Array Last",
    category: "array",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(T)),
      pin("out", "Out", "out", T),
    ],
    codegen: (ctx) => {
      const fallback = outFallback(ctx);
      return {
        out: `((a,d)=>{const l=a??[];return l.length>0?l[l.length-1]:d;})(${ctx.input("array")},${fallback})`,
      };
    },
  },
];

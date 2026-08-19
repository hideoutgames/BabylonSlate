import {
  pin,
  type NodeDefinition,
  STRING,
  INT,
  FLOAT,
  BOOL,
  arrayOf,
} from "@babylonslate/scripting";

export const stringNodes: NodeDefinition[] = [
  {
    id: "string.concat",
    title: "Concat",
    category: "string",
    pure: true,
    pins: () => [
      pin("a", "a", "in", STRING),
      pin("b", "b", "in", STRING),
      pin("out", "out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("a")}) + String(${ctx.input("b")}))`,
    }),
  },
  {
    id: "string.length",
    title: "Length",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "in", "in", STRING),
      pin("out", "out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).length)` }),
  },
  {
    id: "string.equals",
    title: "Equals",
    category: "string",
    pure: true,
    pins: () => [
      pin("a", "a", "in", STRING),
      pin("b", "b", "in", STRING),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("a")}) === String(${ctx.input("b")}))`,
    }),
  },
  {
    id: "string.contains",
    title: "Contains",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("search", "Search", "in", STRING),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).includes(String(${ctx.input("search")})))`,
    }),
  },
  {
    id: "string.startsWith",
    title: "Starts With",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("prefix", "Prefix", "in", STRING),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).startsWith(String(${ctx.input("prefix")})))`,
    }),
  },
  {
    id: "string.endsWith",
    title: "Ends With",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("suffix", "Suffix", "in", STRING),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).endsWith(String(${ctx.input("suffix")})))`,
    }),
  },
  {
    id: "string.replace",
    title: "Replace",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("search", "Search", "in", STRING),
      pin("replacement", "Replacement", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).replaceAll(String(${ctx.input("search")}), String(${ctx.input("replacement")})))`,
    }),
  },
  {
    id: "string.split",
    title: "Split",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("separator", "Separator", "in", STRING),
      pin("out", "Out", "out", arrayOf(STRING)),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).split(String(${ctx.input("separator")})))`,
    }),
  },
  {
    id: "string.join",
    title: "Join",
    category: "string",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(STRING)),
      pin("separator", "Separator", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("array")}) ?? []).map((entry) => String(entry)).join(String(${ctx.input("separator")}))`,
    }),
  },
  {
    id: "string.substring",
    title: "Substring",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("start", "Start", "in", INT),
      pin("end", "End", "in", INT),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).substring((${ctx.input("start")}) | 0, (${ctx.input("end")}) | 0))`,
    }),
  },
  {
    id: "string.trim",
    title: "Trim",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).trim())` }),
  },
  {
    id: "string.toLower",
    title: "To Lower",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).toLowerCase())` }),
  },
  {
    id: "string.toUpper",
    title: "To Upper",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).toUpperCase())` }),
  },
  {
    id: "string.parseInt",
    title: "Parse Int",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", INT),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const raw = `String(${ctx.input("in")}).trim()`;
      return {
        success: `((s => /^-?\\d+$/.test(s))(${raw}))`,
        out: `((s => (/^-?\\d+$/.test(s) ? Number.parseInt(s, 10) : 0))(${raw}))`,
      };
    },
  },
  {
    id: "string.parseFloat",
    title: "Parse Float",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", FLOAT),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const raw = `String(${ctx.input("in")}).trim()`;
      return {
        success: `((s => { const n = Number(s); return s !== "" && Number.isFinite(n); })(${raw}))`,
        out: `((s => { const n = Number.parseFloat(s); return s !== "" && Number.isFinite(n) ? n : 0; })(${raw}))`,
      };
    },
  },
];

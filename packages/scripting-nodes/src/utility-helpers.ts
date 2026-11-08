import {
  pin,
  type GraphPin,
  type NodeDefinition,
  type PinType,
  arrayOf,
  enumRef,
  BOOL,
  EXEC,
  FLOAT,
  INT,
  RESOLVING_WILDCARD,
  ROTATOR,
  STRING,
  VEC3,
  defaultValueLiteral,
  ENGINE_EASING_CURVE_ENUM_ID,
} from "@haptic/scripting";
import { hoistedCall } from "./hoisted-helper";
import { VALUE_INDEX_OF, hasValueTypePin } from "./map";

type Ctx = Parameters<NodeDefinition["codegen"]>[0];
type Input = [id: string, name: string, type: PinType, defaultValue?: unknown];

const T = RESOLVING_WILDCARD;
/** Below this squared distance an Interp To node lands on Target, as Unreal's `SMALL_NUMBER` test. */
const ARRIVED = "1e-8";

/** A pure, referentially transparent node whose single output is `body` over its inputs' expressions. */
function pureNode(
  id: string, title: string, category: string, inputs: readonly Input[], output: [id: string, name: string, type: PinType],
  body: (...args: string[]) => string, description: string, searchAliases?: string[],
): NodeDefinition {
  return {
    id, title, category, description, pure: true, referentiallyTransparent: true, ...(searchAliases ? { searchAliases } : {}),
    pins: () => [
      ...inputs.map(([pinId, name, type, defaultValue]) =>
        defaultValue === undefined ? pin(pinId, name, "in", type) : pin(pinId, name, "in", type, "data", true, defaultValue)),
      pin(output[0], output[1], "out", output[2]),
    ],
    codegen: (ctx) => ({ [output[0]]: body(...inputs.map(([pinId]) => ctx.input(pinId))) }),
  };
}

/** `pureNode` whose body is a hoisted helper `name(params) => expr`, called once per use. */
function helperNode(
  id: string, title: string, category: string, inputs: readonly Input[], output: [string, string, PinType],
  name: string, params: string, expr: string, description: string, searchAliases?: string[],
): NodeDefinition {
  const node = pureNode(id, title, category, inputs, output, () => "", description, searchAliases);
  return { ...node, codegen: (ctx) => ({ [output[0]]: hoistedCall(ctx, name, params, expr, inputs.map(([pinId]) => ctx.input(pinId))) }) };
}

const value = (type: PinType = FLOAT): Input => ["value", "Value", type];
const ab = (type: PinType): Input[] => [["a", "A", type], ["b", "B", type]];
const out = (type: PinType, name = "Return Value"): [string, string, PinType] => ["out", name, type];

/** Wraps degrees into (-180, 180]. */
const NORMALIZE_AXIS = "(a) => { const w = ((a % 360) + 360) % 360; return w > 180 ? w - 360 : w; }";
const VEC = (x: string, y: string, z: string) => `({ x: ${x}, y: ${y}, z: ${z} })`;

const interpPins = (type: PinType): Input[] => [
  ["current", "Current", type], ["target", "Target", type],
  ["deltaTime", "Delta Time", FLOAT], ["interpSpeed", "Interp Speed", FLOAT, 1],
];

const MATH_NODES: NodeDefinition[] = [
  helperNode("math.exp", "Exp", "math", [value()], out(FLOAT), "__util_exp", "v", "Math.exp(v)",
    "e raised to the power of Value.", ["e^x", "exponential"]),
  helperNode("math.ln", "Natural Log", "math", [value()], out(FLOAT), "__util_ln", "v", "(v > 0 ? Math.log(v) : 0)",
    "The logarithm of Value to base e. 0 when Value is not above 0.", ["ln", "loge", "log e"]),
  helperNode("math.logarithm", "Logarithm", "math", [value(), ["base", "Base", FLOAT, 10]], out(FLOAT),
    "__util_logBase", "v, b", "(v > 0 && b > 0 && b !== 1 ? Math.log(v) / Math.log(b) : 0)",
    "The logarithm of Value to Base. 0 when Value or Base is not above 0, or Base is 1.", ["log", "log10", "log base"]),
  helperNode("math.truncate", "Truncate", "math", [value()], out(INT), "__util_trunc", "v", "(Math.trunc(v) || 0)",
    "Value without its fraction, rounded toward zero.", ["trunc", "to int", "integer part"]),
  helperNode("math.fraction", "Fraction", "math", [value()], out(FLOAT), "__util_frac", "v", "(v - Math.floor(v))",
    "The part of Value above the whole number below it, from 0 up to 1.", ["frac", "fractional part"]),
  pureNode("math.square", "Square", "math", [value()], out(FLOAT), (v) => `((${v}) * (${v}))`, "Value multiplied by itself.", ["x^2", "squared"]),
  helperNode("math.wrap", "Wrap", "math", [value(), ["min", "Min", FLOAT, 0], ["max", "Max", FLOAT, 1]], out(FLOAT),
    "__util_wrap", "v, lo, hi", "(hi > lo ? lo + (((v - lo) % (hi - lo)) + (hi - lo)) % (hi - lo) : lo)",
    "Value wrapped into the range from Min up to Max: past Max it starts again from Min. Min when Max is not above Min.", ["wrap around", "loop", "repeat"]),
  helperNode("math.snapToGrid", "Snap To Grid", "math", [value(), ["gridSize", "Grid Size", FLOAT, 1]], out(FLOAT),
    "__util_snap", "v, g", "(g > 0 ? Math.round(v / g) * g : v)",
    "The multiple of Grid Size nearest to Value. Value itself when Grid Size is not above 0.", ["snap", "grid", "round to"]),
  {
    id: "math.ease",
    title: "Ease",
    category: "math",
    description: "Blends from A to B by Alpha along the chosen easing Curve. Alpha is clamped to 0 to 1.",
    searchAliases: ["easing", "ease in", "ease out", "smooth step"],
    pure: true,
    pins: () => [
      pin("a", "A", "in", FLOAT),
      pin("b", "B", "in", FLOAT, "data", true, 1),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("curve", "Curve", "in", enumRef(ENGINE_EASING_CURVE_ENUM_ID), "data", true, "linear"),
      pin("out", "Return Value", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(ctx, "__util_ease", "a, b, t", "(a + (b - a) * t)",
        [ctx.input("a"), ctx.input("b"), `ctx.easeAlpha(${ctx.input("curve")}, ${ctx.input("alpha")})`]),
    }),
  },
  helperNode("math.normalizeAxis", "Normalize Axis", "math", [["angle", "Angle", FLOAT]], out(FLOAT),
    "__util_normalizeAxis", "a", `(${NORMALIZE_AXIS})(a)`,
    "Angle in degrees, wrapped to the same direction between -180 and 180.", ["wrap angle", "unwind"]),
  helperNode("math.clampAngle", "Clamp Angle", "math",
    [["angle", "Angle", FLOAT], ["minAngle", "Min Angle Degrees", FLOAT, -90], ["maxAngle", "Max Angle Degrees", FLOAT, 90]], out(FLOAT),
    "__util_clampAngle", "a, lo, hi",
    `(() => { const n = ${NORMALIZE_AXIS}; const half = (((hi - lo) % 360) + 360) % 360 / 2; const center = n(lo + half);`
      + " const d = n(a - center); return d > half ? n(center + half) : d < -half ? n(center - half) : n(a); })()",
    "Angle in degrees limited to the arc from Min Angle Degrees round to Max Angle Degrees, returned between -180 and 180.", ["limit angle"]),
  pureNode("math.xor", "Boolean Xor", "math", ab(BOOL), out(BOOL), (a, b) => `((${a}) !== (${b}))`,
    "True when exactly one of A and B is true.", ["xor", "exclusive or"]),
  pureNode("math.bitwiseAnd", "Bitwise And", "math", ab(INT), out(INT), (a, b) => `((${a}) & (${b}))`,
    "The bits set in both A and B.", ["&", "and bits", "mask"]),
  pureNode("math.bitwiseOr", "Bitwise Or", "math", ab(INT), out(INT), (a, b) => `((${a}) | (${b}))`,
    "The bits set in A, B or both.", ["|", "or bits"]),
  pureNode("math.bitwiseXor", "Bitwise Xor", "math", ab(INT), out(INT), (a, b) => `((${a}) ^ (${b}))`,
    "The bits set in exactly one of A and B.", ["^", "xor bits"]),
  pureNode("math.bitwiseNot", "Bitwise Not", "math", [value(INT)], out(INT), (v) => `(~(${v}))`,
    "Value with every bit flipped.", ["~", "invert bits"]),
  pureNode("math.shiftLeft", "Shift Left", "math", [value(INT), ["shift", "Shift", INT, 1]], out(INT), (v, s) => `((${v}) << (${s}))`,
    "Value's bits moved Shift places toward the high end; each place doubles it.", ["<<", "bit shift"]),
  pureNode("math.shiftRight", "Shift Right", "math", [value(INT), ["shift", "Shift", INT, 1]], out(INT), (v, s) => `((${v}) >> (${s}))`,
    "Value's bits moved Shift places toward the low end, keeping its sign; each place halves it, rounding down.", [">>", "bit shift"]),
  helperNode("math.floatInterpTo", "Float Interp To", "math", interpPins(FLOAT), out(FLOAT),
    "__util_finterp", "c, t, dt, s", `(s <= 0 ? t : (t - c) * (t - c) < ${ARRIVED} ? t : c + (t - c) * Math.min(Math.max(dt * s, 0), 1))`,
    "Moves Current toward Target by a share of the remaining distance each call, so it slows as it arrives. Interp Speed 0 jumps to Target.", ["finterp", "interp to", "smooth follow"]),
  helperNode("math.floatInterpToConstant", "Float Interp To Constant", "math", interpPins(FLOAT), out(FLOAT),
    "__util_finterpConst", "c, t, dt, s", `(s <= 0 ? t : (t - c) * (t - c) < ${ARRIVED} ? t : c + Math.min(Math.max(t - c, -dt * s), dt * s))`,
    "Moves Current toward Target by at most Interp Speed per second. Interp Speed 0 jumps to Target.", ["finterp constant", "move towards"]),
];

const VECTOR_NODES: NodeDefinition[] = [
  helperNode("vector.interpTo", "Vector Interp To", "vector", interpPins(VEC3), out(VEC3),
    "__util_vinterp", "c, t, dt, s",
    `(() => { const dx = t.x - c.x, dy = t.y - c.y, dz = t.z - c.z; if (s <= 0 || dx * dx + dy * dy + dz * dz < ${ARRIVED}) return { ...t };`
      + ` const k = Math.min(Math.max(dt * s, 0), 1); return ${VEC("c.x + dx * k", "c.y + dy * k", "c.z + dz * k")}; })()`,
    "Moves Current toward Target by a share of the remaining distance each call, so it slows as it arrives. Interp Speed 0 jumps to Target.", ["vinterp", "interp to", "smooth follow"]),
  helperNode("vector.interpToConstant", "Vector Interp To Constant", "vector", interpPins(VEC3), out(VEC3),
    "__util_vinterpConst", "c, t, dt, s",
    `(() => { const dx = t.x - c.x, dy = t.y - c.y, dz = t.z - c.z, d = Math.hypot(dx, dy, dz); const step = dt * s;`
      + ` if (s <= 0 || d * d < ${ARRIVED} || d <= step) return { ...t }; if (!(step > 0)) return { ...c };`
      + ` const k = step / d; return ${VEC("c.x + dx * k", "c.y + dy * k", "c.z + dz * k")}; })()`,
    "Moves Current straight toward Target by at most Interp Speed units per second. Interp Speed 0 jumps to Target.", ["vinterp constant", "move towards"]),
  helperNode("vector.unitDirection", "Get Unit Direction", "vector", [["from", "From", VEC3], ["to", "To", VEC3]], out(VEC3),
    "__util_unitDirection", "f, t",
    `(() => { const dx = t.x - f.x, dy = t.y - f.y, dz = t.z - f.z, d = Math.hypot(dx, dy, dz); return d > 1e-8 ? ${VEC("dx / d", "dy / d", "dz / d")} : ${VEC("0", "0", "0")}; })()`,
    "The direction from From to To, one unit long. Zero when they are the same point.", ["direction", "look direction"]),
  helperNode("vector.angleBetween", "Angle Between Vectors", "vector", ab(VEC3), out(FLOAT, "Degrees"),
    "__util_angleBetween", "a, b",
    "(() => { const l = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z); if (!(l > 0)) return 0;"
      + " return Math.acos(Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y + a.z * b.z) / l))) * 180 / Math.PI; })()",
    "The angle between A and B in degrees, from 0 to 180. 0 when either is zero.", ["angle", "angle between"]),
  helperNode("vector.projectOnTo", "Project Vector On To Vector", "vector", [["vector", "Vector", VEC3], ["target", "Target", VEC3]], out(VEC3),
    "__util_project", "v, t",
    `(() => { const l = t.x * t.x + t.y * t.y + t.z * t.z; if (!(l > 0)) return ${VEC("0", "0", "0")}; const k = (v.x * t.x + v.y * t.y + v.z * t.z) / l;`
      + ` return ${VEC("t.x * k", "t.y * k", "t.z * k")}; })()`,
    "The part of Vector that points along Target. Zero when Target is zero.", ["project"]),
  helperNode("vector.projectOnToPlane", "Project Vector On To Plane", "vector", [["vector", "Vector", VEC3], ["planeNormal", "Plane Normal", VEC3]], out(VEC3),
    "__util_projectPlane", "v, n",
    `(() => { const l = n.x * n.x + n.y * n.y + n.z * n.z; if (!(l > 0)) return { ...v }; const k = (v.x * n.x + v.y * n.y + v.z * n.z) / l;`
      + ` return ${VEC("v.x - n.x * k", "v.y - n.y * k", "v.z - n.z * k")}; })()`,
    "Vector with the part along Plane Normal removed, so it lies flat in the plane. Plane Normal need not be one unit long.", ["flatten", "project plane"]),
  helperNode("vector.mirrorByNormal", "Mirror Vector By Normal", "vector", [["vector", "Vector", VEC3], ["normal", "Normal", VEC3]], out(VEC3),
    "__util_mirror", "v, n",
    `(() => { const l = n.x * n.x + n.y * n.y + n.z * n.z; if (!(l > 0)) return { ...v }; const k = 2 * (v.x * n.x + v.y * n.y + v.z * n.z) / l;`
      + ` return ${VEC("v.x - n.x * k", "v.y - n.y * k", "v.z - n.z * k")}; })()`,
    "Vector bounced off a surface facing Normal, as a ball's velocity bounces off a wall.", ["reflect", "bounce", "mirror"]),
  helperNode("vector.clampSize", "Clamp Vector Size", "vector", [["vector", "Vector", VEC3], ["min", "Min", FLOAT, 0], ["max", "Max", FLOAT, 1]], out(VEC3),
    "__util_clampSize", "v, lo, hi",
    `(() => { const d = Math.hypot(v.x, v.y, v.z); if (!(d > 1e-8)) return { ...v }; const k = Math.min(Math.max(d, lo), Math.max(lo, hi)) / d;`
      + ` return ${VEC("v.x * k", "v.y * k", "v.z * k")}; })()`,
    "Vector in the same direction, with its length kept between Min and Max. A zero vector stays zero.", ["clamp length", "limit speed"]),
  pureNode("vector.nearlyEqual", "Vector3 Nearly Equal", "vector", [...ab(VEC3), ["tolerance", "Tolerance", FLOAT, 0.0001]], out(BOOL),
    (a, b, t) => `(Math.abs((${a}).x - (${b}).x) <= (${t}) && Math.abs((${a}).y - (${b}).y) <= (${t}) && Math.abs((${a}).z - (${b}).z) <= (${t}))`,
    "True when every axis of A and B differs by no more than Tolerance.", ["equal", "approximately"]),
  helperNode("vector.negate", "Negate Vector3", "vector", [["vector", "Vector", VEC3]], out(VEC3),
    "__util_negate3", "v", VEC("-v.x", "-v.y", "-v.z"), "Vector pointing the opposite way.", ["invert", "reverse", "opposite"]),
  helperNode("rotator.interpTo", "Rotator Interp To", "rotator", interpPins(ROTATOR), out(ROTATOR),
    "__util_rinterp", "c, t, dt, s",
    `(() => { const n = ${NORMALIZE_AXIS}; const dp = n(t.pitch - c.pitch), dy = n(t.yaw - c.yaw), dr = n(t.roll - c.roll);`
      + ` if (s <= 0 || dp * dp + dy * dy + dr * dr < ${ARRIVED}) return { ...t }; const k = Math.min(Math.max(dt * s, 0), 1);`
      + " return { pitch: n(c.pitch + dp * k), yaw: n(c.yaw + dy * k), roll: n(c.roll + dr * k) }; })()",
    "Turns Current toward Target the short way round by a share of the remaining angle each call, so it slows as it arrives. Interp Speed 0 jumps to Target.", ["rinterp", "interp to", "smooth turn"]),
];

const STRING_NODES: NodeDefinition[] = [
  helperNode("string.findSubstring", "Find Substring", "string",
    [["string", "Search In", STRING], ["substring", "Substring", STRING], ["fromEnd", "Search From End", BOOL, false]], out(INT, "Index"),
    "__util_findSubstring", "s, sub, end", "(end === true ? String(s ?? \"\").lastIndexOf(String(sub ?? \"\")) : String(s ?? \"\").indexOf(String(sub ?? \"\")))",
    "Where Substring first starts in Search In, counting from 0, or -1 when it is not there. Search From End finds the last one.", ["index of", "indexof", "find", "search"]),
  helperNode("string.reverse", "Reverse String", "string", [["string", "String", STRING]], out(STRING),
    "__util_reverseString", "s", "Array.from(String(s ?? \"\")).reverse().join(\"\")",
    "String with its characters in the opposite order.", ["reverse", "backwards"]),
  pureNode("string.isEmpty", "String Is Empty", "string", [["string", "String", STRING]], out(BOOL),
    (s) => `(String(${s} ?? "").length === 0)`, "True when String has no characters.", ["is empty", "empty string", "blank"]),
  helperNode("string.padLeft", "Pad Left", "string",
    [["string", "String", STRING], ["length", "Length", INT, 0], ["padCharacter", "Pad Character", STRING, " "]], out(STRING),
    "__util_padLeft", "s, n, c", "String(s ?? \"\").padStart(Math.max(0, Math.min(Number(n) || 0, 4096)), String(c ?? \"\") || \" \")",
    "String with Pad Character added before it until it is Length characters long. A longer String is unchanged.", ["pad start", "leading zeros"]),
  helperNode("string.padRight", "Pad Right", "string",
    [["string", "String", STRING], ["length", "Length", INT, 0], ["padCharacter", "Pad Character", STRING, " "]], out(STRING),
    "__util_padRight", "s, n, c", "String(s ?? \"\").padEnd(Math.max(0, Math.min(Number(n) || 0, 4096)), String(c ?? \"\") || \" \")",
    "String with Pad Character added after it until it is Length characters long. A longer String is unchanged.", ["pad end"]),
  helperNode("string.formatFloat", "Format Float", "string", [value(), ["decimals", "Decimals", INT, 2]], out(STRING),
    "__util_formatFloat", "v, d", "(Number.isFinite(v) ? v.toFixed(Math.max(0, Math.min(Math.trunc(Number(d) || 0), 20))) : String(v))",
    "Value as text with exactly Decimals digits after the point, rounded.", ["to fixed", "decimal places", "float to string"]),
];

/** An exec array node whose new array is `body(array, ...inputs)` over a copy, so the input array is never changed. */
function arrayAction(id: string, title: string, inputs: readonly GraphPin[], extraOutputs: readonly GraphPin[],
  body: (ctx: Ctx, array: string) => string, description: string, searchAliases?: string[]): NodeDefinition {
  return {
    id, title, category: "array", description, ...(searchAliases ? { searchAliases } : {}),
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("array", "Array", "in", arrayOf(T)),
      ...inputs,
      pin("out", "Out", "out", arrayOf(T)),
      ...extraOutputs,
    ],
    codegen: (ctx) => {
      ctx.emit(body(ctx, `((${ctx.input("array")}) ?? []).slice()`));
    },
  };
}

/** Max Of / Min Of a Float or Int array: the first extreme item's Index and Value; -1 and 0 when empty. */
function extremeOf(id: string, title: string, type: PinType, max: boolean): NodeDefinition {
  return {
    id, title, category: "array", pure: true,
    description: `The ${max ? "largest" : "smallest"} item in Array and its Index; the first one when several tie. Index -1 and Value 0 when Array is empty.`,
    searchAliases: [max ? "max of" : "min of", max ? "largest" : "smallest"],
    pins: () => [pin("array", "Array", "in", arrayOf(type)), pin("index", "Index", "out", INT), pin("value", "Value", "out", type)],
    codegen: (ctx) => {
      const call = hoistedCall(ctx, max ? "__util_maxOf" : "__util_minOf", "a",
        `(() => { let i = -1; for (let k = 0; k < (a ?? []).length; k++) if (i < 0 || a[k] ${max ? ">" : "<"} a[i]) i = k; return [i, i < 0 ? 0 : a[i]]; })()`,
        [ctx.input("array")]);
      return { index: `${call}[0]`, value: `${call}[1]` };
    },
  };
}

const ARRAY_NODES: NodeDefinition[] = [
  arrayAction("array.sort", "Sort Array", [pin("descending", "Descending", "in", BOOL, "data", true, false)], [],
    (ctx, array) => `${ctx.output("out")} = ${array}.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0) * (${ctx.input("descending")} === true ? -1 : 1));`,
    "A copy of Array in ascending order, or descending with Descending. Numbers sort by value, text alphabetically by character code.", ["sort", "order"]),
  arrayAction("array.addUnique", "Add Unique", [pin("item", "Item", "in", T)], [pin("index", "Index", "out", INT)],
    (ctx, array) => {
      const index = hasValueTypePin(ctx, "item") ? `${VALUE_INDEX_OF}(__a, __item)` : "__a.indexOf(__item)";
      return `{ const __a = ${array}; const __item = ${ctx.input("item")}; let __i = ${index}; if (__i < 0) { __i = __a.length; __a.push(__item); } ${ctx.output("out")} = __a; ${ctx.output("index")} = __i; }`;
    },
    "Array with Item appended unless it already holds an equal item. Index is where Item is in the result.", ["append unique", "add if missing"]),
  arrayAction("array.swap", "Swap Array Items", [pin("first", "First Index", "in", INT), pin("second", "Second Index", "in", INT, "data", true, 1)], [],
    (ctx, array) => `{ const __a = ${array}; const __i = ${ctx.input("first")}, __j = ${ctx.input("second")}; if (Number.isInteger(__i) && Number.isInteger(__j) && __i >= 0 && __j >= 0 && __i < __a.length && __j < __a.length) { const __t = __a[__i]; __a[__i] = __a[__j]; __a[__j] = __t; } ${ctx.output("out")} = __a; }`,
    "Array with the items at First Index and Second Index changed places. Unchanged when either index is outside the array.", ["swap", "exchange"]),
  arrayAction("array.resize", "Resize Array", [pin("size", "Size", "in", INT)], [],
    (ctx, array) => {
      const item = ctx.node.pins.find((entry) => entry.id === "out")?.type;
      const fill = defaultValueLiteral(item?.kind === "array" ? item.element : T);
      return `{ const __a = ${array}; const __n = Math.max(0, Math.min(Math.trunc(Number(${ctx.input("size")}) || 0), 100000)); __a.length = Math.min(__a.length, __n); while (__a.length < __n) __a.push(${fill}); ${ctx.output("out")} = __a; }`;
    },
    "Array cut or extended to Size items. New items take the item type's default value.", ["set length", "set num", "resize"]),
  extremeOf("array.maxOfFloat", "Max Of Float Array", FLOAT, true),
  extremeOf("array.minOfFloat", "Min Of Float Array", FLOAT, false),
  extremeOf("array.maxOfInt", "Max Of Int Array", INT, true),
  extremeOf("array.minOfInt", "Min Of Int Array", INT, false),
];

/** Math, interpolation, vector, string and array helpers. */
export const utilityHelperNodes: NodeDefinition[] = [...MATH_NODES, ...VECTOR_NODES, ...STRING_NODES, ...ARRAY_NODES];

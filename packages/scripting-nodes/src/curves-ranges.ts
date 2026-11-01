import {
  pin,
  structRef,
  type NodeDefinition,
  type PinType,
  BOOL,
  COLOR,
  FLOAT,
  INT,
  ROTATOR,
  VEC2,
  VEC3,
  ENGINE_COLOR_CURVE_STRUCT_ID,
  ENGINE_FLOAT_CURVE_STRUCT_ID,
  ENGINE_FLOAT_RANGE_STRUCT_ID,
  ENGINE_INT_RANGE_STRUCT_ID,
  ENGINE_ROTATOR_RANGE_STRUCT_ID,
  ENGINE_VECTOR2_RANGE_STRUCT_ID,
  ENGINE_VECTOR_CURVE_STRUCT_ID,
  ENGINE_VECTOR_RANGE_STRUCT_ID,
} from "@haptic/scripting";

/**
 * Range and curve reads. Range and Curve values are ordinary built-in Structures (Make and Break work as
 * for any Structure); these nodes add the common reads through `ctx` members backed by `@haptic/core`
 * curves, and the Random nodes draw from the session's seeded generator.
 */

const INT_RANGE = structRef(ENGINE_INT_RANGE_STRUCT_ID);
const FLOAT_RANGE = structRef(ENGINE_FLOAT_RANGE_STRUCT_ID);
const VECTOR2_RANGE = structRef(ENGINE_VECTOR2_RANGE_STRUCT_ID);
const VECTOR_RANGE = structRef(ENGINE_VECTOR_RANGE_STRUCT_ID);
const ROTATOR_RANGE = structRef(ENGINE_ROTATOR_RANGE_STRUCT_ID);
const FLOAT_CURVE = structRef(ENGINE_FLOAT_CURVE_STRUCT_ID);
const VECTOR_CURVE = structRef(ENGINE_VECTOR_CURVE_STRUCT_ID);
const COLOR_CURVE = structRef(ENGINE_COLOR_CURVE_STRUCT_ID);

const ZERO_VECTOR2 = { x: 0, y: 0 };
const ZERO_VECTOR = { x: 0, y: 0, z: 0 };
const ZERO_ROTATOR = { pitch: 0, yaw: 0, roll: 0 };
const EMPTY_CURVE = { Keys: [], Before: "constant", After: "constant" };

type RangeSpec = { kind: string; type: PinType; range: PinType; min: unknown; max: unknown };

const INT_SPEC: RangeSpec = { kind: "int", type: INT, range: INT_RANGE, min: 0, max: 1 };
const FLOAT_SPEC: RangeSpec = { kind: "float", type: FLOAT, range: FLOAT_RANGE, min: 0, max: 1 };
const VECTOR2_SPEC: RangeSpec = { kind: "vec2", type: VEC2, range: VECTOR2_RANGE, min: ZERO_VECTOR2, max: ZERO_VECTOR2 };
const VECTOR_SPEC: RangeSpec = { kind: "vec3", type: VEC3, range: VECTOR_RANGE, min: ZERO_VECTOR, max: ZERO_VECTOR };
const ROTATOR_SPEC: RangeSpec = { kind: "rotator", type: ROTATOR, range: ROTATOR_RANGE, min: ZERO_ROTATOR, max: ZERO_ROTATOR };

function rangePin(id: string, name: string, spec: RangeSpec) {
  return pin(id, name, "in", spec.range, "data", true, { Min: spec.min, Max: spec.max });
}

function randomNode(id: string, title: string, spec: RangeSpec): NodeDefinition {
  return {
    id: `range.random${id}`,
    title: `Random ${title} In Range`,
    category: "range",
    pure: true,
    pins: () => [rangePin("range", "Range", spec), pin("value", "Value", "out", spec.type)],
    codegen: (ctx) => ({ value: `ctx.randomInRange(${JSON.stringify(spec.kind)}, ${ctx.input("range")})` }),
  };
}

function clampNode(id: string, title: string, spec: RangeSpec): NodeDefinition {
  return {
    id: `range.clamp${id}`,
    title: `Clamp ${title} To Range`,
    category: "range",
    pure: true,
    referentiallyTransparent: true,
    pins: () => [
      pin("value", "Value", "in", spec.type),
      rangePin("range", "Range", spec),
      pin("result", "Result", "out", spec.type),
    ],
    codegen: (ctx) => ({
      result: `ctx.clampToRange(${JSON.stringify(spec.kind)}, ${ctx.input("value")}, ${ctx.input("range")})`,
    }),
  };
}

function inRangeNode(id: string, title: string, spec: RangeSpec): NodeDefinition {
  return {
    id: `range.is${id}InRange`,
    title: `Is ${title} In Range`,
    category: "range",
    pure: true,
    referentiallyTransparent: true,
    pins: () => [
      pin("value", "Value", "in", spec.type),
      rangePin("range", "Range", spec),
      pin("result", "Result", "out", BOOL),
    ],
    codegen: (ctx) => ({
      result: `ctx.isInRange(${JSON.stringify(spec.kind)}, ${ctx.input("value")}, ${ctx.input("range")})`,
    }),
  };
}

type CurveSpec = { id: string; title: string; kind: string; curve: PinType; value: PinType };

const CURVES: readonly CurveSpec[] = [
  { id: "Float", title: "Float", kind: "float", curve: FLOAT_CURVE, value: FLOAT },
  { id: "Vector", title: "Vector", kind: "vec3", curve: VECTOR_CURVE, value: VEC3 },
  { id: "Color", title: "Color", kind: "color", curve: COLOR_CURVE, value: COLOR },
];

function curvePin(spec: CurveSpec) {
  return pin("curve", "Curve", "in", spec.curve, "data", true, EMPTY_CURVE);
}

function evaluateNode(spec: CurveSpec): NodeDefinition {
  return {
    id: `curve.evaluate${spec.id}`,
    title: `Evaluate ${spec.title} Curve`,
    category: "curve",
    pure: true,
    referentiallyTransparent: true,
    pins: () => [
      curvePin(spec),
      pin("time", "Time", "in", FLOAT),
      pin("value", "Value", "out", spec.value),
    ],
    codegen: (ctx) => ({
      value: `ctx.evaluateCurve(${JSON.stringify(spec.kind)}, ${ctx.input("curve")}, ${ctx.input("time")})`,
    }),
  };
}

function timeRangeNode(spec: CurveSpec): NodeDefinition {
  return {
    id: `curve.${spec.id.toLowerCase()}TimeRange`,
    title: `Get ${spec.title} Curve Time Range`,
    category: "curve",
    pure: true,
    referentiallyTransparent: true,
    pins: () => [curvePin(spec), pin("timeRange", "Time Range", "out", FLOAT_RANGE)],
    codegen: (ctx) => ({ timeRange: `ctx.curveTimeRange(${ctx.input("curve")})` }),
  };
}

export const curveRangeNodes: NodeDefinition[] = [
  randomNode("Int", "Integer", INT_SPEC),
  randomNode("Float", "Float", FLOAT_SPEC),
  randomNode("Vector2", "Vector 2", VECTOR2_SPEC),
  randomNode("Vector", "Vector", VECTOR_SPEC),
  randomNode("Rotator", "Rotator", ROTATOR_SPEC),
  clampNode("Int", "Integer", INT_SPEC),
  clampNode("Float", "Float", FLOAT_SPEC),
  clampNode("Vector", "Vector", VECTOR_SPEC),
  inRangeNode("Int", "Integer", INT_SPEC),
  inRangeNode("Float", "Float", FLOAT_SPEC),
  {
    id: "range.lerpFloat",
    title: "Lerp Float Range",
    category: "range",
    pure: true,
    referentiallyTransparent: true,
    pins: () => [
      rangePin("range", "Range", FLOAT_SPEC),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("value", "Value", "out", FLOAT),
    ],
    codegen: (ctx) => ({ value: `ctx.lerpFloatRange(${ctx.input("range")}, ${ctx.input("alpha")})` }),
  },
  {
    id: "range.mapFloat",
    title: "Map Float Range",
    category: "range",
    pure: true,
    referentiallyTransparent: true,
    pins: () => [
      pin("value", "Value", "in", FLOAT),
      rangePin("from", "From", FLOAT_SPEC),
      rangePin("to", "To", FLOAT_SPEC),
      pin("clamp", "Clamp", "in", BOOL),
      pin("result", "Result", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      result: `ctx.mapFloatRange(${ctx.input("value")}, ${ctx.input("from")}, ${ctx.input("to")}, ${ctx.input("clamp")})`,
    }),
  },
  ...CURVES.map(evaluateNode),
  ...CURVES.map(timeRangeNode),
  {
    id: "curve.floatValueRange",
    title: "Get Float Curve Value Range",
    category: "curve",
    pure: true,
    referentiallyTransparent: true,
    pins: () => [curvePin(CURVES[0]!), pin("valueRange", "Value Range", "out", FLOAT_RANGE)],
    codegen: (ctx) => ({ valueRange: `ctx.floatCurveValueRange(${ctx.input("curve")})` }),
  },
];

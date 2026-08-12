import { describe, expect, it } from "vitest";
import { pin } from "./node-registry";
import {
  BOOL,
  BOXED_WILDCARD,
  COLOR,
  EXEC,
  FLOAT,
  INT,
  ROTATOR,
  STRING,
  TRANSFORM,
  VEC2,
  VEC3,
  VEC4,
  arrayOf,
  mapOf,
  objectRef,
} from "./types";
import {
  defaultJsValue,
  listUnconnectedLiteralPinDefaults,
  pinAcceptsLiteralDefault,
  pinDefaultPropertyKey,
  readPinDefault,
} from "./pin-defaults";

describe("pinAcceptsLiteralDefault", () => {
  it("accepts primitive, vector, rotator, and color pins", () => {
    expect(pinAcceptsLiteralDefault(BOOL)).toBe(true);
    expect(pinAcceptsLiteralDefault(INT)).toBe(true);
    expect(pinAcceptsLiteralDefault(FLOAT)).toBe(true);
    expect(pinAcceptsLiteralDefault(STRING)).toBe(true);
    expect(pinAcceptsLiteralDefault(VEC2)).toBe(true);
    expect(pinAcceptsLiteralDefault(VEC3)).toBe(true);
    expect(pinAcceptsLiteralDefault(ROTATOR)).toBe(true);
    expect(pinAcceptsLiteralDefault(COLOR)).toBe(true);
  });

  it("rejects exec, refs, containers, vec4, transform, and wildcards", () => {
    expect(pinAcceptsLiteralDefault(EXEC)).toBe(false);
    expect(pinAcceptsLiteralDefault(VEC4)).toBe(false);
    expect(pinAcceptsLiteralDefault(TRANSFORM)).toBe(false);
    expect(pinAcceptsLiteralDefault(arrayOf(FLOAT))).toBe(false);
    expect(pinAcceptsLiteralDefault(mapOf(STRING, FLOAT))).toBe(false);
    expect(pinAcceptsLiteralDefault(objectRef("Actor"))).toBe(false);
    expect(pinAcceptsLiteralDefault(BOXED_WILDCARD)).toBe(false);
  });
});

describe("defaultJsValue", () => {
  it("returns JS values that match the type-table literals", () => {
    expect(defaultJsValue(BOOL)).toBe(false);
    expect(defaultJsValue(INT)).toBe(0);
    expect(defaultJsValue(FLOAT)).toBe(0);
    expect(defaultJsValue(STRING)).toBe("");
    expect(defaultJsValue(VEC2)).toEqual({ x: 0, y: 0 });
    expect(defaultJsValue(VEC3)).toEqual({ x: 0, y: 0, z: 0 });
    expect(defaultJsValue(ROTATOR)).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    expect(defaultJsValue(COLOR)).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  });
});

describe("readPinDefault", () => {
  it("prefers default:name over a bare pin-named property", () => {
    expect(
      readPinDefault({ "default:a": 4, a: 2 }, "a"),
    ).toBe(4);
    expect(readPinDefault({ a: 2 }, "a")).toBe(2);
    expect(readPinDefault({}, "a")).toBeUndefined();
  });
});

describe("pinDefaultPropertyKey", () => {
  it("namespaces authored defaults so they do not collide with node properties", () => {
    expect(pinDefaultPropertyKey("message")).toBe("default:message");
  });
});

describe("listUnconnectedLiteralPinDefaults", () => {
  const pins = [
    pin("execIn", "exec", "in", EXEC),
    pin("a", "a", "in", FLOAT),
    pin("b", "b", "in", FLOAT),
    pin("out", "out", "out", FLOAT),
  ];

  it("lists unconnected applicable data inputs with stored or type defaults", () => {
    const listed = listUnconnectedLiteralPinDefaults(pins, { "default:a": 2 }, new Set());
    expect(listed).toEqual([
      { pinId: "a", name: "a", type: FLOAT, value: 2 },
      { pinId: "b", name: "b", type: FLOAT, value: 0 },
    ]);
  });

  it("omits connected pins and non-literal types", () => {
    const listed = listUnconnectedLiteralPinDefaults(
      pins,
      {},
      new Set(["a"]),
    );
    expect(listed.map((entry) => entry.pinId)).toEqual(["b"]);
  });
});

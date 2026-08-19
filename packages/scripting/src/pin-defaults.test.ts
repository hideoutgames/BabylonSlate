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
  actorRef,
  assetRef,
  classRef,
  objectRef,
  enumRef,
  structRef,
} from "./types";
import {
  defaultJsValue,
  listUnconnectedLiteralPinDefaults,
  pinAcceptsLiteralDefault,
  pinRejectsStoredDefault,
  pinDefaultAsBoolean,
  pinDefaultAsNumber,
  pinDefaultAsString,
  pinDefaultAsVec3Tuple,
  pinDefaultAsVec4Tuple,
  pinDefaultColorRgb,
  pinDefaultPropertyKey,
  readPinDefault,
  colorRgbToPinDefault,
  vec3TupleToObject,
  vec4TupleToObject,
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
    expect(pinAcceptsLiteralDefault(VEC4)).toBe(true);
    expect(pinAcceptsLiteralDefault(enumRef("e1"))).toBe(true);
    expect(pinAcceptsLiteralDefault(classRef("Actor"))).toBe(true);
    expect(pinAcceptsLiteralDefault(assetRef("Audio"))).toBe(true);
    expect(pinAcceptsLiteralDefault(structRef("s1"))).toBe(true);
  });

  it("rejects exec, object refs, containers, transform, and wildcards", () => {
    expect(pinAcceptsLiteralDefault(EXEC)).toBe(false);
    expect(pinAcceptsLiteralDefault(TRANSFORM)).toBe(false);
    expect(pinAcceptsLiteralDefault(arrayOf(FLOAT))).toBe(false);
    expect(pinAcceptsLiteralDefault(mapOf(STRING, FLOAT))).toBe(false);
    expect(pinAcceptsLiteralDefault(objectRef("Actor"))).toBe(false);
    expect(pinAcceptsLiteralDefault(actorRef("Actor"))).toBe(false);
    expect(pinAcceptsLiteralDefault(BOXED_WILDCARD)).toBe(false);
  });
});

describe("pinRejectsStoredDefault", () => {
  it("rejects only live object and actor instance pins", () => {
    expect(pinRejectsStoredDefault(objectRef("Actor"))).toBe(true);
    expect(pinRejectsStoredDefault(actorRef("Actor"))).toBe(true);
    expect(pinRejectsStoredDefault(classRef("Actor"))).toBe(false);
    expect(pinRejectsStoredDefault(assetRef("Audio"))).toBe(false);
    expect(pinRejectsStoredDefault(BOXED_WILDCARD)).toBe(false);
    expect(pinRejectsStoredDefault(STRING)).toBe(false);
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
    expect(defaultJsValue(VEC4)).toEqual({ x: 0, y: 0, z: 0, w: 0 });
    expect(defaultJsValue(enumRef("e1"))).toBe("");
    expect(defaultJsValue(structRef("s1"))).toEqual({});
    expect(defaultJsValue(classRef("Actor"))).toBe("Actor");
    expect(defaultJsValue(assetRef("Audio"))).toBe("");
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

  it("reads a stored default by pin id when the display name is Title Case", () => {
    const listed = listUnconnectedLiteralPinDefaults(
      [pin("location", "Location", "in", VEC3)],
      { "default:location": { x: 1, y: 2, z: 3 } },
      new Set(),
    );
    expect(listed).toEqual([
      {
        pinId: "location",
        name: "Location",
        type: VEC3,
        value: { x: 1, y: 2, z: 3 },
      },
    ]);
  });

  it("uses catalog pin defaultValue before the type-table default", () => {
    const listed = listUnconnectedLiteralPinDefaults(
      [pin("duration", "Duration", "in", FLOAT, "data", true, 2)],
      {},
      new Set(),
    );
    expect(listed).toEqual([
      { pinId: "duration", name: "Duration", type: FLOAT, value: 2 },
    ]);
  });
});

describe("pin default editor conversions", () => {
  it("coerces scalars used by the property grid", () => {
    expect(pinDefaultAsBoolean(true)).toBe(true);
    expect(pinDefaultAsBoolean("nope")).toBe(false);
    expect(pinDefaultAsNumber(3.5)).toBe(3.5);
    expect(pinDefaultAsNumber("8")).toBe(8);
    expect(pinDefaultAsNumber("nope")).toBe(0);
    expect(pinDefaultAsString("hi")).toBe("hi");
    expect(pinDefaultAsString(12)).toBe("12");
  });

  it("round-trips vec2, vec3, and rotator objects through XYZ tuples", () => {
    expect(pinDefaultAsVec3Tuple({ x: 1, y: 2 }, ["x", "y"])).toEqual([1, 2, 0]);
    expect(vec3TupleToObject([1, 2, 9], ["x", "y"])).toEqual({ x: 1, y: 2 });
    expect(pinDefaultAsVec3Tuple({ x: 1, y: 2, z: 3 }, ["x", "y", "z"])).toEqual([
      1, 2, 3,
    ]);
    expect(vec3TupleToObject([4, 5, 6], ["x", "y", "z"])).toEqual({
      x: 4,
      y: 5,
      z: 6,
    });
    expect(
      pinDefaultAsVec3Tuple({ pitch: 10, yaw: 20, roll: 30 }, [
        "pitch",
        "yaw",
        "roll",
      ]),
    ).toEqual([10, 20, 30]);
    expect(vec3TupleToObject([10, 20, 30], ["pitch", "yaw", "roll"])).toEqual({
      pitch: 10,
      yaw: 20,
      roll: 30,
    });
  });

  it("maps color RGB in the grid while preserving authored alpha", () => {
    expect(pinDefaultColorRgb({ x: 1, y: 0.5, z: 0, w: 0.25 })).toEqual([
      1, 0.5, 0,
    ]);
    expect(colorRgbToPinDefault([0.2, 0.4, 0.6], { w: 0.8 })).toEqual({
      x: 0.2,
      y: 0.4,
      z: 0.6,
      w: 0.8,
    });
    expect(colorRgbToPinDefault([1, 1, 1], undefined)).toEqual({
      x: 1,
      y: 1,
      z: 1,
      w: 0,
    });
  });

  it("round-trips vec4 objects through XYZW tuples", () => {
    expect(pinDefaultAsVec4Tuple({ x: 1, y: 2, z: 3, w: 4 })).toEqual([
      1, 2, 3, 4,
    ]);
    expect(vec4TupleToObject([9, 8, 7, 6])).toEqual({
      x: 9,
      y: 8,
      z: 7,
      w: 6,
    });
  });
});

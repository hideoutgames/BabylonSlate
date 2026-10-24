import { describe, expect, it } from "vitest";
import {
  BOOL,
  BOXED_WILDCARD,
  FLOAT,
  QUAT,
  ROTATOR,
  arrayOf,
  assetRef,
  mapOf,
  objectRef,
  pinTypeForMember,
  pinTypeForVariable,
  typeIdFromPinType,
  typeClassIdFromPinType,
  variableTypeFromPinType,
} from "./index";

describe("pinTypeForMember picker gaps", () => {
  it("emits objectRef, assetRef, boxed wildcard, and quat", () => {
    expect(pinTypeForMember("object")).toEqual(objectRef("Object"));
    expect(pinTypeForMember("object", "Hero")).toEqual(objectRef("Hero"));
    expect(pinTypeForMember("asset", "Audio")).toEqual(assetRef("Audio"));
    expect(pinTypeForMember("wildcard")).toEqual(BOXED_WILDCARD);
    expect(pinTypeForMember("quat")).toEqual(QUAT);
  });

});

describe("pinTypeForVariable", () => {
  it("wraps Single, Array, and Map independently of the inner type", () => {
    expect(pinTypeForVariable({ typeId: "rotator" })).toEqual(ROTATOR);
    expect(
      pinTypeForVariable({ typeId: "rotator", container: "array" }),
    ).toEqual(arrayOf(ROTATOR));
    expect(
      pinTypeForVariable({
        typeId: "float",
        container: "map",
        keyTypeId: "string",
      }),
    ).toEqual(mapOf(pinTypeForMember("string"), FLOAT));
  });

  it("round-trips one container level through typeIdFromPinType", () => {
    const arrayType = pinTypeForVariable({
      typeId: "bool",
      container: "array",
    });
    expect(typeIdFromPinType(arrayType)).toBe("bool");
    expect(variableTypeFromPinType(arrayType)).toEqual({
      typeId: "bool",
      container: "array",
    });
    const mapType = pinTypeForVariable({
      typeId: "object",
      typeClassId: "Hero",
      container: "map",
      keyTypeId: "string",
    });
    expect(typeIdFromPinType(mapType)).toBe("object");
    expect(typeClassIdFromPinType(mapType)).toBe("Hero");
    expect(variableTypeFromPinType(mapType)).toEqual({
      typeId: "object",
      typeClassId: "Hero",
      container: "map",
      keyTypeId: "string",
    });
    expect(typeIdFromPinType(BOOL)).toBe("bool");
    expect(typeIdFromPinType(objectRef("Hero"))).toBe("object");
    expect(typeIdFromPinType(assetRef("Audio"))).toBe("asset");
    expect(typeClassIdFromPinType(assetRef("Audio"))).toBe("Audio");
    expect(typeIdFromPinType(BOXED_WILDCARD)).toBe("wildcard");
    expect(typeIdFromPinType(QUAT)).toBe("quat");
  });
});

import { describe, expect, it } from "vitest";
import {
  BOOL,
  BOXED_WILDCARD,
  FLOAT,
  QUAT,
  ROTATOR,
  actorRef,
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
  it("emits actorRef, assetRef, boxed wildcard, and quat", () => {
    expect(pinTypeForMember("actor")).toEqual(actorRef("Actor"));
    expect(pinTypeForMember("actor", "Hero")).toEqual(actorRef("Hero"));
    expect(pinTypeForMember("asset", "Audio")).toEqual(assetRef("Audio"));
    expect(pinTypeForMember("wildcard")).toEqual(BOXED_WILDCARD);
    expect(pinTypeForMember("quat")).toEqual(QUAT);
  });

  it("emits actorRef for object pins whose class is Actor ancestry", () => {
    expect(pinTypeForMember("object", "Actor")).toEqual(actorRef("Actor"));
    expect(pinTypeForMember("object", "Hero")).toEqual(objectRef("Hero"));
    const hierarchy = {
      isSubclassOf(child: string, parent: string) {
        return child === "Hero" && parent === "Actor";
      },
    };
    expect(pinTypeForMember("object", "Hero", hierarchy)).toEqual(
      actorRef("Hero"),
    );
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
      typeId: "actor",
      typeClassId: "Hero",
      container: "map",
      keyTypeId: "string",
    });
    expect(typeIdFromPinType(mapType)).toBe("actor");
    expect(typeClassIdFromPinType(mapType)).toBe("Hero");
    expect(variableTypeFromPinType(mapType)).toEqual({
      typeId: "actor",
      typeClassId: "Hero",
      container: "map",
      keyTypeId: "string",
    });
    expect(typeIdFromPinType(BOOL)).toBe("bool");
    expect(typeIdFromPinType(actorRef("Hero"))).toBe("actor");
    expect(typeIdFromPinType(assetRef("Audio"))).toBe("asset");
    expect(typeClassIdFromPinType(assetRef("Audio"))).toBe("Audio");
    expect(typeIdFromPinType(BOXED_WILDCARD)).toBe("wildcard");
    expect(typeIdFromPinType(QUAT)).toBe("quat");
  });
});

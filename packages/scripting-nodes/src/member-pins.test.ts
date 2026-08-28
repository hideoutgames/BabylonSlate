import { describe, expect, it } from "vitest";
import {
  BOOL,
  COLOR,
  FLOAT,
  ROTATOR,
  TRANSFORM,
  VEC3,
  VEC4,
  objectRef,
  classRef,
  structRef,
  enumRef,
  isAssignable,
} from "@babylonslate/scripting";
import {
  jsIdent,
  localVariableIdent,
  objectLiteralKey,
  pinTypeForMember,
  localVariablePreamble,
  typeClassIdFromPinType,
  typeIdFromPinType,
} from "./member-pins";

describe("pinTypeForMember", () => {
  it("maps picker ids instead of collapsing unknown types to float", () => {
    expect(pinTypeForMember("bool")).toEqual(BOOL);
    expect(pinTypeForMember("vec3")).toEqual(VEC3);
    expect(pinTypeForMember("vec4")).toEqual(VEC4);
    expect(pinTypeForMember("rotator")).toEqual(ROTATOR);
    expect(pinTypeForMember("color")).toEqual(COLOR);
    expect(pinTypeForMember("transform")).toEqual(TRANSFORM);
    expect(pinTypeForMember("object")).toEqual(objectRef("BObject"));
    expect(pinTypeForMember("class")).toEqual(classRef("BObject"));
    expect(pinTypeForMember("struct")).toEqual(structRef(""));
    expect(pinTypeForMember("enum")).toEqual(enumRef(""));
    expect(pinTypeForMember("float")).toEqual(FLOAT);
  });

  it("uses typeClassId as the object and class pin constraint", () => {
    expect(pinTypeForMember("object", "Hero")).toEqual(objectRef("Hero"));
    expect(pinTypeForMember("class", "Actor")).toEqual(classRef("Actor"));
    expect(pinTypeForMember("object", "  ")).toEqual(objectRef("BObject"));
    expect(pinTypeForMember("class")).toEqual(classRef("BObject"));
  });

  it("uses typeClassId as the Structure and Enum asset guid", () => {
    expect(pinTypeForMember("struct", "struct-health")).toEqual(
      structRef("struct-health"),
    );
    expect(pinTypeForMember("enum", "enum-team")).toEqual(enumRef("enum-team"));
    expect(pinTypeForMember("struct", "  ")).toEqual(structRef(""));
    expect(pinTypeForMember("enum")).toEqual(enumRef(""));
  });

  it("does not assign an unbound struct pin to a typed Structure pin", () => {
    expect(
      isAssignable(pinTypeForMember("struct"), pinTypeForMember("struct", "s1")),
    ).toBe(false);
    expect(
      isAssignable(
        pinTypeForMember("struct", "s1"),
        pinTypeForMember("struct", "s2"),
      ),
    ).toBe(false);
    expect(
      isAssignable(
        pinTypeForMember("enum", "e1"),
        pinTypeForMember("enum", "e1"),
      ),
    ).toBe(true);
  });

  it("maps pin types back to picker ids and typeClassId", () => {
    expect(typeIdFromPinType(enumRef("enum-team"))).toBe("enum");
    expect(typeClassIdFromPinType(enumRef("enum-team"))).toBe("enum-team");
    expect(typeIdFromPinType(structRef("struct-stats"))).toBe("struct");
    expect(typeClassIdFromPinType(structRef(""))).toBeUndefined();
    expect(typeIdFromPinType(VEC4)).toBe("vec4");
    expect(typeIdFromPinType(objectRef("Hero"))).toBe("object");
  });
});

describe("jsIdent", () => {
  it("turns event member names into export identifiers", () => {
    expect(jsIdent("On Hit")).toBe("On_Hit");
    expect(jsIdent("2 Jump!")).toBe("_2_Jump_");
  });
});

describe("localVariableIdent", () => {
  it("prefixes a stable ident so locals cannot collide with ctx", () => {
    expect(localVariableIdent("Temp")).toBe("__lv_Temp");
    expect(localVariableIdent("ctx")).toBe("__lv_ctx");
    expect(localVariableIdent("2 Temp!")).toBe("__lv__2_Temp_");
  });
});

describe("objectLiteralKey", () => {
  it("quotes keys that are not JS identifiers", () => {
    expect(objectLiteralKey("result")).toBe("result");
    expect(objectLiteralKey("2 Jump!")).toBe('"2 Jump!"');
  });
});

describe("localVariablePreamble", () => {
  it("emits JSON array defaults for Array locals and Map pairs for Map locals", () => {
    expect(
      localVariablePreamble([
        {
          name: "Hits",
          typeId: "float",
          container: "array",
          defaultValue: [1, 2],
        },
        {
          name: "By Name",
          typeId: "float",
          container: "map",
          keyTypeId: "string",
          defaultValue: [{ key: "a", value: 1 }],
        },
        {
          name: "Empty Map",
          typeId: "float",
          container: "map",
          keyTypeId: "string",
        },
      ]),
    ).toEqual([
      "  let __lv_Hits = [1,2];",
      '  let __lv_By_Name = new Map([["a",1]]);',
      "  let __lv_Empty_Map = new Map();",
    ]);
  });
});

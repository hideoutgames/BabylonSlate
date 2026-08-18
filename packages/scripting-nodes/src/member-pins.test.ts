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
import { jsIdent, localVariableIdent, objectLiteralKey, pinTypeForMember } from "./member-pins";

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

import { describe, expect, it } from "vitest";
import { BOOL, FLOAT, VEC3, objectRef, classRef, structRef, enumRef } from "@babylonslate/scripting";
import { jsIdent, localVariableIdent, objectLiteralKey, pinTypeForMember } from "./member-pins";

describe("pinTypeForMember", () => {
  it("maps picker ids instead of collapsing unknown types to float", () => {
    expect(pinTypeForMember("bool")).toEqual(BOOL);
    expect(pinTypeForMember("vec3")).toEqual(VEC3);
    expect(pinTypeForMember("object")).toEqual(objectRef("BObject"));
    expect(pinTypeForMember("class")).toEqual(classRef("BObject"));
    expect(pinTypeForMember("struct")).toEqual(structRef(""));
    expect(pinTypeForMember("enum")).toEqual(enumRef(""));
    expect(pinTypeForMember("float")).toEqual(FLOAT);
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

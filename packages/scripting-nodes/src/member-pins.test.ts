import { describe, expect, it } from "vitest";
import { BOOL, FLOAT, VEC3, objectRef, classRef, structRef, enumRef } from "@babylonslate/scripting";
import { jsIdent, pinTypeForMember } from "./member-pins";

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

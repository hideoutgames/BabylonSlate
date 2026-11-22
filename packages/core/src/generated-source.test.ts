import { describe, expect, it } from "vitest";
import { generatedCommentText, sourceUrlComment, sourceUrlLabel } from "./generated-source";

describe("generated comment and source label text", () => {
  it("leaves printable ASCII as it is, so guids, paths and stack mapping keys keep their text", () => {
    expect(sourceUrlLabel("assets/My Hero.class.hasset~Hero")).toBe("assets/My Hero.class.hasset~Hero");
    expect(generatedCommentText("flow.break node-1: not inside a loop")).toBe("flow.break node-1: not inside a loop");
  });

  it.each(["\n", "\r", "\u2028", "\u2029", "\ud800"])("escapes %j, which would end a line comment", (terminator) => {
    const label = sourceUrlLabel(`a${terminator}b`);
    expect(label).toMatch(/^a%u[0-9a-f]{4}b$/);
    expect(generatedCommentText(`a${terminator}b`)).toMatch(/^a\\u[0-9a-f]{4}b$/);
    expect(sourceUrlComment(`a${terminator}b`)).not.toMatch(/[\n\r\u2028\u2029]/);
  });

  it("breaks a block comment's end", () => {
    expect(generatedCommentText("x */ evil(); /*")).toBe("x *\\/ evil(); /*");
  });
});

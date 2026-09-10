import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { codeCompletions } from "./code-completion";

describe("code completion", () => {
  it("offers authored pins and local GLSL declarations alongside built-ins", () => {
    const state = EditorState.create({ doc: "vec3 tint;\nmi" });
    const result = codeCompletions(new CompletionContext(state, state.doc.length, true), "glsl", ["Mask", "invalid name"]);
    expect(result?.from).toBe(11);
    expect(result?.options.map((option) => option.label)).toEqual(expect.arrayContaining(["mix", "Mask", "tint"]));
    expect(result?.options.map((option) => option.label)).not.toContain("invalid name");
  });
  it("keeps GLSL built-ins out of JavaScript and waits for typing or explicit requests", () => {
    const state = EditorState.create({ doc: "const count = 1; " });
    expect(codeCompletions(new CompletionContext(state, state.doc.length, false), "javascript", [])).toBeNull();
    const result = codeCompletions(new CompletionContext(state, state.doc.length, true), "javascript", ["Input"]);
    expect(result?.options.map((option) => option.label)).toEqual(["Input", "count"]);
  });
});

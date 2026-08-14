import { describe, expect, it } from "vitest";
import {
  shouldPromptBeforeUnload,
  tabCloseDecision,
} from "./dirty-document-prompts";

describe("tabCloseDecision", () => {
  it("prompts Save / Discard / Cancel when the tab is dirty", () => {
    expect(tabCloseDecision(true)).toBe("prompt");
  });

  it("closes immediately when the tab is clean", () => {
    expect(tabCloseDecision(false)).toBe("close");
  });
});

describe("shouldPromptBeforeUnload", () => {
  it("prompts the browser when any document is dirty", () => {
    expect(shouldPromptBeforeUnload(1)).toBe(true);
    expect(shouldPromptBeforeUnload(0)).toBe(false);
  });
});

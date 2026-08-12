import { afterEach, describe, expect, it } from "vitest";
import {
  shouldSuppressIosEditingGesture,
  shouldSuppressIosHistoryInput,
} from "./ios-editing-gestures";

function shell(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

function input(): HTMLInputElement {
  const el = document.createElement("input");
  document.body.append(el);
  return el;
}

describe("shouldSuppressIosEditingGesture", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("suppresses three-finger touches on ordinary chrome", () => {
    expect(shouldSuppressIosEditingGesture(3, shell())).toBe(true);
    expect(shouldSuppressIosEditingGesture(4, shell())).toBe(true);
  });

  it("does not suppress one- or two-finger touches", () => {
    const el = shell();
    expect(shouldSuppressIosEditingGesture(1, el)).toBe(false);
    expect(shouldSuppressIosEditingGesture(2, el)).toBe(false);
  });

  it("leaves three-finger undo available in text fields", () => {
    expect(shouldSuppressIosEditingGesture(3, input())).toBe(false);
  });

  it("leaves three-finger undo available inside selectable text", () => {
    const wrap = document.createElement("span");
    wrap.className = "selectable-text";
    const child = document.createElement("span");
    wrap.append(child);
    document.body.append(wrap);
    expect(shouldSuppressIosEditingGesture(3, child)).toBe(false);
  });
});

describe("shouldSuppressIosHistoryInput", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("suppresses synthesized historyUndo and historyRedo outside fields", () => {
    const el = shell();
    expect(shouldSuppressIosHistoryInput("historyUndo", el)).toBe(true);
    expect(shouldSuppressIosHistoryInput("historyRedo", el)).toBe(true);
  });

  it("does not suppress ordinary typing inputTypes", () => {
    expect(shouldSuppressIosHistoryInput("insertText", shell())).toBe(false);
  });

  it("leaves historyUndo in a text field so typing undo still works", () => {
    expect(shouldSuppressIosHistoryInput("historyUndo", input())).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "./storage-range";

describe("utf8ByteLength", () => {
  it.each([
    ["empty", ""],
    ["ASCII", "project.json"],
    ["two-byte", "café ñ"],
    ["three-byte", "€ 日本語"],
    ["surrogate pair", "a\u{1f600}b\u{10ffff}"],
    ["lone high surrogate at the end", "ab\ud83d"],
    ["lone high surrogate before text", "\ud83dab"],
    ["lone low surrogate", "a\ude00b"],
    ["reversed pair", "\ude00\ud83d"],
    ["high surrogate before a pair", "\ud83d😀"],
    ["mixed", "xé€\u{1f600}\ud800y\udc00"],
  ])("matches TextEncoder for %s", (_name, text) => {
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
  });
});

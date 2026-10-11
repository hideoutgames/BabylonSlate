import { describe, expect, it } from "vitest";
import { previewPackFromFiles } from "@babylonslate/exporter";
import { previewPackFromExpectedHostMessage } from "./preview-protocol";

describe("preview pack protocol", () => {
  it("delivers a handoff with its trace budget only from the expected parent and origin", () => {
    const parentWindow = {} as Window;
    const otherWindow = {} as Window;
    const files = new Map([["game.json", new TextEncoder().encode("{}")]]);
    const pack = previewPackFromFiles(files, 1024);
    expect(previewPackFromExpectedHostMessage(
      { source: parentWindow, origin: "https://preview.example", data: pack },
      parentWindow, "https://preview.example",
    )).toBe(pack);
    expect(previewPackFromExpectedHostMessage(
      { source: parentWindow, origin: "https://preview.example", data: { ...pack, traceByteBudget: undefined } },
      parentWindow, "https://preview.example",
    )).toBeNull();
    expect(previewPackFromExpectedHostMessage(
      { source: otherWindow, origin: "https://preview.example", data: pack },
      parentWindow, "https://preview.example",
    )).toBeNull();
    expect(previewPackFromExpectedHostMessage(
      { source: parentWindow, origin: "https://attacker.example", data: pack },
      parentWindow, "https://preview.example",
    )).toBeNull();
  });
});

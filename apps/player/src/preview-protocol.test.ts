import { describe, expect, it } from "vitest";
import { previewPackFromFiles } from "@babylonslate/exporter";
import { previewPackFromExpectedHostMessage } from "./preview-protocol";

describe("preview pack protocol", () => {
  it("delivers a pack only from the expected parent and origin", () => {
    const parentWindow = {} as Window;
    const otherWindow = {} as Window;
    const pack = previewPackFromFiles(new Map([["game.json", new Uint8Array([1])]]));
    expect(previewPackFromExpectedHostMessage(
      { source: parentWindow, origin: "https://preview.example", data: pack },
      parentWindow, "https://preview.example",
    )).toBe(pack);
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

import { describe, expect, it } from "vitest";
import { previewPackFromFiles } from "@haptic/exporter";
import { previewHostOrigin, previewPackFromExpectedHostMessage } from "./preview-protocol";

describe("preview host origin", () => {
  it("talks to the embedding editor's origin, which the desktop app keeps apart from the player's", () => {
    expect(previewHostOrigin({ origin: "app://preview", ancestorOrigins: ["app://babylonslate"] })).toBe("app://babylonslate");
    expect(previewHostOrigin({ origin: "https://site.example", ancestorOrigins: ["https://site.example"] })).toBe("https://site.example");
  });

  it("trusts only its own origin without a known embedder", () => {
    expect(previewHostOrigin({ origin: "https://site.example" })).toBe("https://site.example");
    expect(previewHostOrigin({ origin: "https://site.example", ancestorOrigins: [] })).toBe("https://site.example");
    expect(previewHostOrigin({ origin: "app://preview", ancestorOrigins: ["null"] })).toBe("app://preview");
  });
});

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

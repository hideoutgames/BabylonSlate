import { describe, expect, it } from "vitest";
import { canSendPreviewPack } from "./preview-build-handoff";

describe("canSendPreviewPack", () => {
  const files = new Map([["game.json", new Uint8Array([1])]]);

  it("allows the handshake while Preview Build is open", () => {
    expect(canSendPreviewPack({ files, closing: false })).toBe(true);
  });

  it("refuses a pack resend after Stop so the player cannot relaunch", () => {
    expect(canSendPreviewPack({ files, closing: true })).toBe(false);
    expect(canSendPreviewPack({ files: null, closing: false })).toBe(false);
  });
});

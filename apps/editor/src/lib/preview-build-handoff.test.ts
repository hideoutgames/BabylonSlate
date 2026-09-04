import { describe, expect, it } from "vitest";
import {
  canSendPreviewPack,
  editorViewportPausedForSession,
  isExpectedPreviewMessage,
  previewTargetFromSrc,
} from "./preview-build-handoff";

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

describe("Preview Build message boundary", () => {
  const previewWindow = {} as Window;
  const otherWindow = {} as Window;

  it("derives and retains the exact iframe origin", () => {
    expect(previewTargetFromSrc("/BabylonSlate/player/?preview=1", "https://preview.example/editor/"))
      .toEqual({ src: "/BabylonSlate/player/?preview=1", origin: "https://preview.example" });
  });

  it("ignores another window or origin", () => {
    expect(isExpectedPreviewMessage(
      { source: previewWindow, origin: "https://preview.example" }, previewWindow, "https://preview.example",
    )).toBe(true);
    expect(isExpectedPreviewMessage(
      { source: otherWindow, origin: "https://preview.example" }, previewWindow, "https://preview.example",
    )).toBe(false);
    expect(isExpectedPreviewMessage(
      { source: previewWindow, origin: "https://attacker.example" }, previewWindow, "https://preview.example",
    )).toBe(false);
  });
});

describe("editorViewportPausedForSession", () => {
  it("keeps the Scene viewport running when idle", () => {
    expect(
      editorViewportPausedForSession({ playing: false, preparing: false }),
    ).toBe(false);
  });

  it("pauses the editor Engine while overlay Play or Preview pack/iframe is live", () => {
    expect(
      editorViewportPausedForSession({ playing: true, preparing: false }),
    ).toBe(true);
    expect(
      editorViewportPausedForSession({ playing: false, preparing: true }),
    ).toBe(true);
  });
});
